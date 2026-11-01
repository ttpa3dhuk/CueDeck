/*
 * CueDeck Syphon CPU bridge helper.
 *
 * The main process sends bounded BGRA frames over stdin using frame_protocol.h.
 * This helper uploads each frame to a Metal texture and publishes it through
 * SyphonMetalServer. It is intentionally a separate process: Metal waits and
 * helper crashes cannot block Electron's main event loop.
 *
 * Modes:
 *   serve     read framed BGRA frames from stdin, ACK each published frame
 *   selftest  private server + Metal client, asymmetric fixture and alpha check
 *   bench     bounded synthetic upload/publish benchmark (private server)
 *
 * `serve` is private by default. It becomes a public Syphon source only with an
 * explicit --public. The main process passes that only after its own dev opt-in.
 */
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <IOSurface/IOSurface.h>
#import <Syphon/Syphon.h>

#include "frame_protocol.h"

#include <dispatch/dispatch.h>
#include <errno.h>
#include <math.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t gStop = 0;

static void CDSignalHandler(int sig) {
    (void)sig;
    gStop = 1;
}

static double CDNowMs(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1000000.0;
}

static void CDSleepMs(double ms) {
    if (ms <= 0.0) return;
    struct timespec req;
    req.tv_sec = (time_t)(ms / 1000.0);
    req.tv_nsec = (long)((ms - (double)req.tv_sec * 1000.0) * 1000000.0);
    while (!gStop && nanosleep(&req, &req) != 0 && errno == EINTR) {}
}

static NSError *CDError(NSString *message) {
    return [NSError errorWithDomain:@"CueDeckSyphonHelper" code:1
                           userInfo:@{NSLocalizedDescriptionKey: message}];
}

static BOOL CDWriteAll(int fd, const void *bytes, size_t length) {
    const uint8_t *p = (const uint8_t *)bytes;
    size_t sent = 0;
    while (sent < length) {
        ssize_t n = write(fd, p + sent, length - sent);
        if (n < 0) {
            if (errno == EINTR) continue;
            return NO;
        }
        if (n == 0) return NO;
        sent += (size_t)n;
    }
    return YES;
}

static BOOL CDSendAck(int fd, uint32_t status, uint64_t frameId, uint32_t detail) {
    uint8_t ack[CD_ACK_HEADER_BYTES];
    cd_encode_ack(ack, status, frameId, detail);
    return CDWriteAll(fd, ack, sizeof(ack));
}

/* read exactly length bytes; returns bytes read (can be short on EOF/error). */
static size_t CDReadSome(int fd, void *buffer, size_t length, BOOL *eof, BOOL *error) {
    uint8_t *p = (uint8_t *)buffer;
    size_t got = 0;
    *eof = NO;
    *error = NO;
    while (got < length) {
        if (gStop) return got;
        ssize_t n = read(fd, p + got, length - got);
        if (n == 0) {
            *eof = YES;
            return got;
        }
        if (n < 0) {
            if (errno == EINTR) continue;
            *error = YES;
            return got;
        }
        got += (size_t)n;
    }
    return got;
}

#pragma mark - Publisher

@interface CDSyphonPublisher : NSObject
@property(nonatomic, readonly) BOOL fatal;
- (NSDictionary<NSString *, id> *)serverDescription;
- (instancetype)initWithName:(NSString *)name
                    private:(BOOL)isPrivate
                      flipY:(BOOL)flipY
                 timeoutMs:(NSUInteger)timeoutMs
                      error:(NSError **)error;
- (BOOL)publishBGRA:(const void *)bytes
              width:(NSUInteger)width
             height:(NSUInteger)height
             stride:(NSUInteger)stride
         originTop:(BOOL)originTop
            frameId:(uint64_t)frameId
              error:(NSError **)error;
- (void)stop;
@end

@implementation CDSyphonPublisher {
    id<MTLDevice> _device;
    id<MTLCommandQueue> _queue;
    SyphonMetalServer *_server;
    id<MTLTexture> _texture;
    NSMutableData *_flipScratch;
    BOOL _flipY;
    NSUInteger _timeoutMs;
    NSUInteger _width;
    NSUInteger _height;
    BOOL _fatal;
}

- (instancetype)initWithName:(NSString *)name
                    private:(BOOL)isPrivate
                      flipY:(BOOL)flipY
                 timeoutMs:(NSUInteger)timeoutMs
                      error:(NSError **)error {
    self = [super init];
    if (!self) return nil;
    _device = MTLCreateSystemDefaultDevice();
    if (!_device) {
        if (error) *error = CDError(@"Metal is unavailable");
        return nil;
    }
    _queue = [_device newCommandQueue];
    if (!_queue) {
        if (error) *error = CDError(@"cannot create a Metal command queue");
        return nil;
    }
    NSDictionary *options = isPrivate ? @{SyphonServerOptionIsPrivate: @YES} : nil;
    _server = [[SyphonMetalServer alloc] initWithName:name device:_device options:options];
    if (!_server) {
        if (error) *error = CDError(@"cannot create SyphonMetalServer (Metal shader resources missing?)");
        return nil;
    }
    _flipY = flipY;
    _timeoutMs = timeoutMs;
    return self;
}

- (void)dealloc {
    [self stop];
}

- (BOOL)fatal {
    return _fatal;
}

- (NSDictionary<NSString *, id> *)serverDescription {
    return _server ? _server.serverDescription : nil;
}

- (void)stop {
    if (_server) {
        [_server stop];
        _server = nil;
    }
    _texture = nil;
    _flipScratch = nil;
    _queue = nil;
    _device = nil;
}

- (BOOL)publishBGRA:(const void *)bytes
              width:(NSUInteger)width
             height:(NSUInteger)height
             stride:(NSUInteger)stride
         originTop:(BOOL)originTop
            frameId:(uint64_t)frameId
              error:(NSError **)error {
    (void)frameId;
    if (!bytes || width < CD_MIN_DIMENSION || height < CD_MIN_DIMENSION ||
        width > CD_MAX_WIDTH || height > CD_MAX_HEIGHT ||
        stride < width * 4 || stride > CD_MAX_STRIDE || stride % 4 != 0) {
        if (error) *error = CDError(@"invalid BGRA dimensions or stride");
        return NO;
    }
    if (!_server || !_queue || !_device || _fatal) {
        if (error) *error = CDError(_fatal ? @"publisher is in fatal timeout state" : @"publisher is stopped");
        return NO;
    }

    if (!_texture || _width != width || _height != height) {
        MTLTextureDescriptor *descriptor =
            [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                                               width:width
                                                              height:height
                                                           mipmapped:NO];
        descriptor.usage = MTLTextureUsageShaderRead;
        descriptor.storageMode = MTLStorageModeShared;
        _texture = [_device newTextureWithDescriptor:descriptor];
        if (!_texture) {
            if (error) *error = CDError(@"cannot create BGRA Metal texture");
            return NO;
        }
        _flipScratch = nil;
        _width = width;
        _height = height;
    }

    const void *upload = bytes;
    NSUInteger uploadStride = stride;
    if (!originTop) {
        /* Normalize bottom-left input to Metal's top-left rows once, bounded. */
        NSUInteger packed = width * 4;
        if (!_flipScratch || _flipScratch.length != packed * height) {
            _flipScratch = [NSMutableData dataWithLength:packed * height];
        }
        if (!_flipScratch) {
            if (error) *error = CDError(@"cannot allocate origin-normalization buffer");
            return NO;
        }
        const uint8_t *src = (const uint8_t *)bytes;
        uint8_t *dst = (uint8_t *)_flipScratch.mutableBytes;
        for (NSUInteger y = 0; y < height; y++) {
            memcpy(dst + y * packed, src + (height - 1 - y) * stride, packed);
        }
        upload = dst;
        uploadStride = packed;
    }

    [_texture replaceRegion:MTLRegionMake2D(0, 0, width, height)
               mipmapLevel:0
                 withBytes:upload
               bytesPerRow:uploadStride];

    id<MTLCommandBuffer> commandBuffer = [_queue commandBuffer];
    if (!commandBuffer) {
        if (error) *error = CDError(@"cannot create Metal command buffer");
        return NO;
    }
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    [commandBuffer addCompletedHandler:^(id<MTLCommandBuffer> _Nonnull completed) {
        (void)completed;
        dispatch_semaphore_signal(semaphore);
    }];
    commandBuffer.label = @"CueDeck Syphon bridge publish";
    [_server publishFrameTexture:_texture
                 onCommandBuffer:commandBuffer
                     imageRegion:NSMakeRect(0, 0, (CGFloat)width, (CGFloat)height)
                         flipped:_flipY];
    [commandBuffer commit];

    long waited = dispatch_semaphore_wait(
        semaphore, dispatch_time(DISPATCH_TIME_NOW, (int64_t)_timeoutMs * NSEC_PER_MSEC));
    if (waited != 0) {
        _fatal = YES; /* do not call waitUntilCompleted and do not reuse texture */
        if (error) {
            *error = CDError([NSString stringWithFormat:@"Metal command buffer timed out after %lu ms",
                              (unsigned long)_timeoutMs]);
        }
        return NO;
    }
    if (commandBuffer.status == MTLCommandBufferStatusError) {
        if (error) *error = commandBuffer.error ?: CDError(@"Metal command buffer failed");
        return NO;
    }
    return YES;
}

@end

#pragma mark - Fixture

static void CDSetPixel(uint8_t *p, uint8_t b, uint8_t g, uint8_t r, uint8_t a) {
    p[0] = b; p[1] = g; p[2] = r; p[3] = a;
}

static void CDFillRect(uint8_t *pixels, NSUInteger width, NSUInteger height,
                       NSUInteger x0, NSUInteger y0, NSUInteger w, NSUInteger h,
                       uint8_t b, uint8_t g, uint8_t r, uint8_t a) {
    for (NSUInteger y = y0; y < y0 + h && y < height; y++) {
        for (NSUInteger x = x0; x < x0 + w && x < width; x++) {
            CDSetPixel(pixels + (y * width + x) * 4, b, g, r, a);
        }
    }
}

/* Opaque colored corners, a transparent centre hole and a premultiplied
 * half-alpha patch. Rows are top-left in the returned data. */
static NSData *CDCreateFixture(NSUInteger width, NSUInteger height, BOOL bottomLeftRows) {
    NSMutableData *data = [NSMutableData dataWithLength:width * height * 4];
    uint8_t *pixels = (uint8_t *)data.mutableBytes;
    CDFillRect(pixels, width, height, 0, 0, width / 2, height / 2, 0, 0, 255, 255);             /* TL red */
    CDFillRect(pixels, width, height, width / 2, 0, width - width / 2, height / 2, 0, 255, 0, 255); /* TR green */
    CDFillRect(pixels, width, height, 0, height / 2, width / 2, height - height / 2, 255, 0, 0, 255); /* BL blue */
    CDFillRect(pixels, width, height, width / 2, height / 2, width - width / 2, height - height / 2, 0, 255, 255, 255); /* BR yellow */
    CDFillRect(pixels, width, height, width / 2 - 8, height / 2 - 8, 16, 16, 0, 0, 0, 0); /* transparent hole */
    /* Premultiplied half-alpha patch: RGB is already <= alpha. */
    CDFillRect(pixels, width, height, 8, height / 2 - 8, 16, 16, 16, 32, 64, 128);

    if (bottomLeftRows) {
        NSMutableData *flipped = [NSMutableData dataWithLength:data.length];
        uint8_t *dst = (uint8_t *)flipped.mutableBytes;
        NSUInteger row = width * 4;
        for (NSUInteger y = 0; y < height; y++) {
            memcpy(dst + y * row, pixels + (height - 1 - y) * row, row);
        }
        return flipped;
    }
    return data;
}

#pragma mark - Client selftest

static BOOL CDIsColor(const uint8_t *p, char wanted) {
    uint8_t b = p[0], g = p[1], r = p[2], a = p[3];
    if (a < 250) return NO;
    switch (wanted) {
        case 'R': return r > 220 && g < 40 && b < 40;
        case 'G': return g > 220 && r < 40 && b < 40;
        case 'B': return b > 220 && r < 40 && g < 40;
        case 'Y': return r > 220 && g > 220 && b < 40;
        default: return NO;
    }
}

static int CDCheckClientFrame(SyphonMetalClient *client, const char *label, BOOL flipY,
                              NSUInteger *outZeroAlpha, NSUInteger *outHalfAlpha) {
    for (int attempt = 0; attempt < 120 && !gStop; attempt++) {
        if (client.hasNewFrame) break;
        CDSleepMs(10);
    }
    id<MTLTexture> image = [client newFrameImage];
    if (!image) {
        fprintf(stderr, "%s: no client frame\n", label);
        return 1;
    }
    NSUInteger w = image.width, h = image.height, row = w * 4;
    NSMutableData *data = [NSMutableData dataWithLength:row * h];
    @try {
        [image getBytes:data.mutableBytes bytesPerRow:row
             fromRegion:MTLRegionMake2D(0, 0, w, h) mipmapLevel:0];
    } @catch (NSException *exception) {
        fprintf(stderr, "%s: cannot read texture: %s\n", label, exception.reason.UTF8String);
        return 1;
    }
    const uint8_t *pixels = (const uint8_t *)data.bytes;
    uint8_t *tl = (uint8_t *)pixels + (2 * w + 2) * 4;
    uint8_t *tr = (uint8_t *)pixels + (2 * w + (w - 3)) * 4;
    uint8_t *bl = (uint8_t *)pixels + ((h - 3) * w + 2) * 4;
    uint8_t *br = (uint8_t *)pixels + ((h - 3) * w + (w - 3)) * 4;
    char expectedTL = flipY ? 'B' : 'R';
    char expectedTR = flipY ? 'Y' : 'G';
    char expectedBL = flipY ? 'R' : 'B';
    char expectedBR = flipY ? 'G' : 'Y';
    if (!CDIsColor(tl, expectedTL) || !CDIsColor(tr, expectedTR) ||
        !CDIsColor(bl, expectedBL) || !CDIsColor(br, expectedBR)) {
        fprintf(stderr, "%s: orientation mismatch TL=%c TR=%c BL=%c BR=%c (expected %c%c%c%c)\n",
                label, CDIsColor(tl, 'R') ? 'R' : CDIsColor(tl, 'G') ? 'G' : CDIsColor(tl, 'B') ? 'B' : CDIsColor(tl, 'Y') ? 'Y' : '?',
                CDIsColor(tr, 'R') ? 'R' : CDIsColor(tr, 'G') ? 'G' : CDIsColor(tr, 'B') ? 'B' : CDIsColor(tr, 'Y') ? 'Y' : '?',
                CDIsColor(bl, 'R') ? 'R' : CDIsColor(bl, 'G') ? 'G' : CDIsColor(bl, 'B') ? 'B' : CDIsColor(bl, 'Y') ? 'Y' : '?',
                CDIsColor(br, 'R') ? 'R' : CDIsColor(br, 'G') ? 'G' : CDIsColor(br, 'B') ? 'B' : CDIsColor(br, 'Y') ? 'Y' : '?',
                expectedTL, expectedTR, expectedBL, expectedBR);
        return 1;
    }
    NSUInteger zeroAlpha = 0, halfAlpha = 0;
    for (NSUInteger i = 0; i < w * h; i++) {
        uint8_t a = pixels[i * 4 + 3];
        if (a == 0) zeroAlpha++;
        if (a == 128) {
            halfAlpha++;
            if (pixels[i * 4 + 0] > a || pixels[i * 4 + 1] > a || pixels[i * 4 + 2] > a) {
                fprintf(stderr, "%s: non-premultiplied half-alpha pixel\n", label);
                return 1;
            }
        }
    }
    if (zeroAlpha == 0 || halfAlpha == 0) {
        fprintf(stderr, "%s: alpha check failed (zero=%lu half=%lu)\n",
                label, (unsigned long)zeroAlpha, (unsigned long)halfAlpha);
        return 1;
    }
    if (outZeroAlpha) *outZeroAlpha = zeroAlpha;
    if (outHalfAlpha) *outHalfAlpha = halfAlpha;
    return 0;
}

static int CDRunSelftest(BOOL flipY, NSUInteger timeoutMs) {
    NSError *error = nil;
    const NSUInteger width = 96, height = 64;
    CDSyphonPublisher *publisher =
        [[CDSyphonPublisher alloc] initWithName:@"CueDeck Syphon Helper Selftest"
                                        private:YES flipY:flipY timeoutMs:timeoutMs error:&error];
    if (!publisher) {
        fprintf(stderr, "selftest: publisher: %s\n", error.localizedDescription.UTF8String);
        return 1;
    }
    SyphonMetalClient *client =
        [[SyphonMetalClient alloc] initWithServerDescription:publisher.serverDescription
                                                      device:MTLCreateSystemDefaultDevice()
                                                     options:nil newFrameHandler:nil];
    if (!client) {
        fprintf(stderr, "selftest: cannot create client\n");
        [publisher stop];
        return 1;
    }
    int status = 1;
    do {
        NSData *topLeft = CDCreateFixture(width, height, NO);
        if (![publisher publishBGRA:topLeft.bytes width:width height:height stride:width * 4
                         originTop:YES frameId:1 error:&error]) {
            fprintf(stderr, "selftest: publish top-left: %s\n", error.localizedDescription.UTF8String);
            break;
        }
        for (int i = 0; i < 100 && !client.isValid && !gStop; i++) CDSleepMs(10);
        if (!client.isValid) {
            fprintf(stderr, "selftest: client did not connect\n");
            break;
        }
        NSUInteger zero = 0, half = 0;
        if (CDCheckClientFrame(client, "top-left", flipY, &zero, &half) != 0) break;

        NSData *bottomLeft = CDCreateFixture(width, height, YES);
        if (![publisher publishBGRA:bottomLeft.bytes width:width height:height stride:width * 4
                         originTop:NO frameId:2 error:&error]) {
            fprintf(stderr, "selftest: publish bottom-left: %s\n", error.localizedDescription.UTF8String);
            break;
        }
        if (CDCheckClientFrame(client, "bottom-left", flipY, &zero, &half) != 0) break;
        printf("SELFTEST PASS: helper input->Metal client frame, flipY=%d, alpha zero=%lu half=%lu\n",
               flipY ? 1 : 0, (unsigned long)zero, (unsigned long)half);
        printf("(Metal client; Resolume/OpenGL orientation is not proven by this test)\n");
        status = 0;
    } while (0);
    [client stop];
    [publisher stop];
    if (status != 0) fprintf(stderr, "SELFTEST FAIL\n");
    return status;
}

#pragma mark - Synthetic bench

static int CDCompareDouble(const void *a, const void *b) {
    double x = *(const double *)a, y = *(const double *)b;
    return x < y ? -1 : x > y ? 1 : 0;
}

static double CDPercentile(double *values, NSUInteger count, double p) {
    if (count == 0) return 0.0;
    NSUInteger index = (NSUInteger)ceil(p * (double)count) - 1;
    if (index >= count) index = count - 1;
    return values[index];
}

static int CDRunBench(const char *sizeName, NSUInteger frames, NSUInteger fps, BOOL flipY,
                      NSUInteger timeoutMs) {
    NSUInteger width = 1920, height = 1080;
    if (strcmp(sizeName, "4k") == 0) {
        width = 3840;
        height = 2160;
    } else if (strcmp(sizeName, "1080p") != 0) {
        fprintf(stderr, "bench: --size must be 1080p or 4k\n");
        return 2;
    }
    if (frames < 1 || frames > 300 || fps < 1 || fps > 60) {
        fprintf(stderr, "bench: --frames must be 1..300, --fps 1..60\n");
        return 2;
    }
    NSError *error = nil;
    CDSyphonPublisher *publisher =
        [[CDSyphonPublisher alloc] initWithName:@"CueDeck Syphon Helper Bench"
                                        private:YES flipY:flipY timeoutMs:timeoutMs error:&error];
    if (!publisher) {
        fprintf(stderr, "bench: publisher: %s\n", error.localizedDescription.UTF8String);
        return 1;
    }
    NSMutableData *fixture = [NSMutableData dataWithLength:width * height * 4];
    uint8_t *pixels = (uint8_t *)fixture.mutableBytes;
    for (NSUInteger y = 0; y < height; y++) {
        for (NSUInteger x = 0; x < width; x++) {
            uint8_t *p = pixels + (y * width + x) * 4;
            p[0] = (uint8_t)(x & 0xff);
            p[1] = (uint8_t)(y & 0xff);
            p[2] = (uint8_t)((x + y) & 0xff);
            p[3] = 255;
        }
    }
    double *times = calloc(frames, sizeof(double));
    if (!times) {
        [publisher stop];
        fprintf(stderr, "bench: allocation failed\n");
        return 1;
    }
    double started = CDNowMs();
    double next = started;
    NSUInteger completed = 0;
    for (NSUInteger i = 0; i < frames && !gStop && !publisher.fatal; i++) {
        double t0 = CDNowMs();
        if (![publisher publishBGRA:fixture.bytes width:width height:height stride:width * 4
                         originTop:YES frameId:(uint64_t)(i + 1) error:&error]) {
            fprintf(stderr, "bench: publish %lu: %s\n", (unsigned long)i + 1,
                    error.localizedDescription.UTF8String);
            break;
        }
        times[completed++] = CDNowMs() - t0;
        next += 1000.0 / (double)fps;
        double now = CDNowMs();
        if (now < next) CDSleepMs(next - now);
        else next = now;
    }
    qsort(times, completed, sizeof(double), CDCompareDouble);
    struct rusage usage;
    getrusage(RUSAGE_SELF, &usage);
    double elapsed = CDNowMs() - started;
    printf("{\"kind\":\"synthetic-helper-bench\",\"synthetic\":true,\"size\":\"%s\","
           "\"width\":%lu,\"height\":%lu,\"frames\":%lu,\"fpsTarget\":%lu,"
           "\"elapsedMs\":%.3f,\"publishMs\":{\"p50\":%.3f,\"p95\":%.3f,\"max\":%.3f},"
           "\"maxRssBytes\":%ld,\"flipY\":%d}\n",
           sizeName, (unsigned long)width, (unsigned long)height, (unsigned long)completed,
           (unsigned long)fps, elapsed,
           CDPercentile(times, completed, 0.50),
           CDPercentile(times, completed, 0.95),
           completed ? times[completed - 1] : 0.0,
           (long)usage.ru_maxrss, flipY ? 1 : 0);
    free(times);
    [publisher stop];
    return completed == frames && !publisher.fatal ? 0 : 1;
}

#pragma mark - CLI

typedef struct cd_options {
    NSString *name;
    BOOL isPrivate;
    BOOL flipY;
    NSUInteger timeoutMs;
    NSUInteger frames;
    NSUInteger fps;
    const char *size;
} cd_options;

static BOOL CDParseBool(NSString *value, BOOL *out) {
    if ([value isEqualToString:@"0"] || [value isEqualToString:@"no"]) { *out = NO; return YES; }
    if ([value isEqualToString:@"1"] || [value isEqualToString:@"yes"]) { *out = YES; return YES; }
    return NO;
}

static BOOL CDParseUInt(NSString *value, NSUInteger min, NSUInteger max, NSUInteger *out) {
    NSScanner *scanner = [NSScanner scannerWithString:value];
    long long parsed = 0;
    if (![scanner scanLongLong:&parsed] || !scanner.isAtEnd || parsed < (long long)min || parsed > (long long)max) return NO;
    *out = (NSUInteger)parsed;
    return YES;
}

static BOOL CDParseCommon(NSArray<NSString *> *args, NSUInteger start, cd_options *options) {
    for (NSUInteger i = start; i < args.count; i++) {
        NSString *arg = args[i];
        if ([arg isEqualToString:@"--name"]) {
            if (++i >= args.count || args[i].length == 0 || args[i].length > 128) return NO;
            options->name = args[i];
        } else if ([arg isEqualToString:@"--private"]) {
            options->isPrivate = YES;
        } else if ([arg isEqualToString:@"--public"]) {
            options->isPrivate = NO;
        } else if ([arg isEqualToString:@"--flip-y"]) {
            if (++i >= args.count || !CDParseBool(args[i], &options->flipY)) return NO;
        } else if ([arg isEqualToString:@"--timeout-ms"]) {
            if (++i >= args.count || !CDParseUInt(args[i], 100, 10000, &options->timeoutMs)) return NO;
        } else if ([arg isEqualToString:@"--frames"]) {
            if (++i >= args.count || !CDParseUInt(args[i], 1, 300, &options->frames)) return NO;
        } else if ([arg isEqualToString:@"--fps"]) {
            if (++i >= args.count || !CDParseUInt(args[i], 1, 60, &options->fps)) return NO;
        } else if ([arg isEqualToString:@"--size"]) {
            if (++i >= args.count) return NO;
            options->size = args[i].UTF8String;
        } else {
            return NO;
        }
    }
    return YES;
}

static void CDUsage(FILE *out) {
    fprintf(out,
        "CueDeckSyphonHelper — bounded CPU BGRA -> Syphon Metal helper\n"
        "\n"
        "  CueDeckSyphonHelper serve [--name NAME] [--public|--private]\n"
        "      [--flip-y 0|1] [--timeout-ms 100..10000]\n"
        "  CueDeckSyphonHelper selftest [--flip-y 0|1] [--timeout-ms N]\n"
        "  CueDeckSyphonHelper bench [--size 1080p|4k] [--frames 1..300]\n"
        "      [--fps 1..60] [--flip-y 0|1] [--timeout-ms N]\n"
        "\n"
        "serve is private by default; --public is required to appear in Resolume.\n"
        "Frames are binary (frame_protocol.h), premultiplied BGRA, bounded 4096x2160.\n"
        "--flip-y applies Syphon's vertical flipped flag; it is not proven for Resolume\n"
        "until the manual CueDeck frame test. X is never flipped by this helper.\n");
}

static int CDRunServe(cd_options options) {
    NSError *error = nil;
    CDSyphonPublisher *publisher =
        [[CDSyphonPublisher alloc] initWithName:options.name
                                        private:options.isPrivate
                                          flipY:options.flipY
                                     timeoutMs:options.timeoutMs
                                          error:&error];
    if (!publisher) {
        fprintf(stderr, "serve: %s\n", error.localizedDescription.UTF8String);
        return 1;
    }
    if (!CDSendAck(STDOUT_FILENO, CD_STATUS_READY, 0, 0)) {
        [publisher stop];
        return 1;
    }
    fprintf(stderr, "serve: \"%s\" %s, flipY=%d, timeout=%lums\n",
            options.name.UTF8String, options.isPrivate ? "private" : "PUBLIC",
            options.flipY ? 1 : 0, (unsigned long)options.timeoutMs);
    uint8_t header[CD_FRAME_HEADER_BYTES];
    int result = 0;
    for (;;) {
        if (gStop) break;
        BOOL eof = NO, readError = NO;
        size_t got = CDReadSome(STDIN_FILENO, header, sizeof(header), &eof, &readError);
        if (gStop) break;
        if (got == 0 && eof) break;
        if (got != sizeof(header)) {
            fprintf(stderr, "serve: short header (%zu/%u)\n", got, CD_FRAME_HEADER_BYTES);
            result = 1;
            break;
        }
        cd_frame_header parsed;
        char why[160] = {0};
        if (cd_parse_frame_header(header, sizeof(header), &parsed, why, sizeof(why)) != 0) {
            fprintf(stderr, "serve: protocol error: %s\n", why);
            uint64_t id = cd_read_u64(header + 28);
            CDSendAck(STDOUT_FILENO, CD_STATUS_PROTOCOL_ERROR, id, 0);
            result = 1;
            break;
        }
        uint8_t *payload = malloc(parsed.payload_length);
        if (!payload) {
            fprintf(stderr, "serve: payload allocation failed\n");
            CDSendAck(STDOUT_FILENO, CD_STATUS_INTERNAL, parsed.frame_id, 0);
            result = 1;
            break;
        }
        got = CDReadSome(STDIN_FILENO, payload, parsed.payload_length, &eof, &readError);
        if (gStop) {
            free(payload);
            break;
        }
        if (got != parsed.payload_length) {
            fprintf(stderr, "serve: short payload (%zu/%u), eof=%d error=%d\n",
                    got, parsed.payload_length, eof, readError);
            free(payload);
            result = 1;
            break;
        }
        BOOL originTop = (parsed.flags & CD_FLAG_TOP_LEFT) != 0;
        BOOL ok = [publisher publishBGRA:payload width:parsed.width height:parsed.height
                                   stride:parsed.stride originTop:originTop
                                  frameId:parsed.frame_id error:&error];
        free(payload);
        if (!ok) {
            fprintf(stderr, "serve: publish %llu: %s\n",
                    (unsigned long long)parsed.frame_id, error.localizedDescription.UTF8String);
            uint32_t status = publisher.fatal ? CD_STATUS_GPU_TIMEOUT : CD_STATUS_BAD_FRAME;
            CDSendAck(STDOUT_FILENO, status, parsed.frame_id, 0);
            result = 1;
            break;
        }
        if (!CDSendAck(STDOUT_FILENO, CD_STATUS_PUBLISHED, parsed.frame_id, 0)) {
            result = 1;
            break;
        }
    }
    [publisher stop];
    return result;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        struct sigaction action;
        memset(&action, 0, sizeof(action));
        action.sa_handler = CDSignalHandler;
        sigemptyset(&action.sa_mask);
        sigaction(SIGINT, &action, NULL);
        sigaction(SIGTERM, &action, NULL);
        signal(SIGPIPE, SIG_IGN);

        NSArray<NSString *> *args = [NSProcessInfo processInfo].arguments;
        if (args.count < 2) {
            CDUsage(stderr);
            return 2;
        }
        NSString *command = args[1];
        if ([command isEqualToString:@"--help"] || [command isEqualToString:@"-h"]) {
            CDUsage(stdout);
            return 0;
        }
        cd_options options;
        options.name = @"CueDeck Syphon Bridge";
        options.isPrivate = YES;
        options.flipY = NO;
        options.timeoutMs = 2000;
        options.frames = 30;
        options.fps = 30;
        options.size = "1080p";
        if (!CDParseCommon(args, 2, &options)) {
            fprintf(stderr, "bad arguments\n");
            CDUsage(stderr);
            return 2;
        }
        if ([command isEqualToString:@"serve"]) return CDRunServe(options);
        if ([command isEqualToString:@"selftest"]) return CDRunSelftest(options.flipY, options.timeoutMs);
        if ([command isEqualToString:@"bench"]) return CDRunBench(options.size, options.frames, options.fps, options.flipY, options.timeoutMs);
        fprintf(stderr, "unknown command: %s\n", command.UTF8String);
        CDUsage(stderr);
        return 2;
    }
}
