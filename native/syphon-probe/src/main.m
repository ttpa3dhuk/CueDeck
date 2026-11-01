/*
 * CueDeck Syphon Probe
 *
 * A deliberately small macOS Syphon Metal sender used to prove the SDK path
 * before any CueDeck integration. It is a command-line program: it creates no
 * windows and requires no NSApplication run loop. The sender starts only for
 * an explicit `send` subcommand.
 *
 * The publishBGRA: method is the minimal native bridge surface for a later
 * CPU-readback prototype. It is not connected to CueDeck and is not zero-copy.
 */

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreText/CoreText.h>
#import <IOSurface/IOSurface.h>
#import <Syphon/Syphon.h>

#include <errno.h>
#include <math.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static NSString *const kDefaultServerName = @"CueDeck Syphon Test";
static const NSUInteger kDefaultWidth = 640;
static const NSUInteger kDefaultHeight = 360;
static const double kFramesPerSecond = 30.0;
static const double kSendSeconds = 30.0;
static const double kProbeSeconds = 5.0;

static volatile sig_atomic_t gStop = 0;

static void CDSignalHandler(int signalNumber)
{
    (void)signalNumber;
    gStop = 1;
}

static NSError *CDError(NSString *message)
{
    return [NSError errorWithDomain:@"CueDeckSyphonProbe"
                               code:1
                           userInfo:@{NSLocalizedDescriptionKey: message}];
}

static void CDPrintError(NSString *prefix, NSError *error)
{
    NSString *message = error.localizedDescription ?: @"unknown error";
    fprintf(stderr, "%s: %s\n", prefix.UTF8String, message.UTF8String);
}

static double CDMonotonicNow(void)
{
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) {
        return 0.0;
    }
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1000000000.0;
}

static BOOL CDInstallSignalHandlers(NSError **error)
{
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = CDSignalHandler;
    sigemptyset(&action.sa_mask);
    action.sa_flags = 0; /* let nanosleep return so gStop is observed promptly */

    if (sigaction(SIGINT, &action, NULL) != 0 || sigaction(SIGTERM, &action, NULL) != 0) {
        if (error) {
            *error = CDError([NSString stringWithFormat:@"sigaction failed: %s", strerror(errno)]);
        }
        return NO;
    }
    return YES;
}

static void CDPumpRunLoop(double seconds)
{
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:MAX(0.0, seconds)];
    [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:until];
}

static void CDDrawText(CGContextRef context, NSString *text, CTFontRef font,
                       CGColorRef color, CGPoint position)
{
    NSDictionary *attributes = @{
        (__bridge id)kCTFontAttributeName: (__bridge id)font,
        (__bridge id)kCTForegroundColorAttributeName: (__bridge id)color,
    };
    NSAttributedString *string = [[NSAttributedString alloc] initWithString:text attributes:attributes];
    CTLineRef line = CTLineCreateWithAttributedString((__bridge CFAttributedStringRef)string);
    if (!line) {
        return;
    }
    CGContextSaveGState(context);
    CGContextSetTextMatrix(context, CGAffineTransformIdentity);
    CGContextSetTextPosition(context, position.x, position.y);
    CTLineDraw(line, context);
    CGContextRestoreGState(context);
    CFRelease(line);
}

/* BGRA8 test pattern; every frame is rendered on the CPU by design. */
@interface CDTestPattern : NSObject
@property(nonatomic, readonly) NSUInteger width;
@property(nonatomic, readonly) NSUInteger height;
@property(nonatomic, readonly) const void *pixels;
@property(nonatomic, readonly) size_t bytesPerRow;
- (instancetype)initWithWidth:(NSUInteger)width height:(NSUInteger)height error:(NSError **)error;
- (void)renderFrame:(uint64_t)frame;
@end

@implementation CDTestPattern {
    NSUInteger _width;
    NSUInteger _height;
    NSMutableData *_data;
    CGContextRef _context;
    CGColorSpaceRef _colorSpace;
    CTFontRef _titleFont;
    CTFontRef _counterFont;
    CTFontRef _noteFont;
    CGColorRef _white;
    CGColorRef _black;
    CGColorRef _muted;
}

- (instancetype)initWithWidth:(NSUInteger)width height:(NSUInteger)height error:(NSError **)error
{
    self = [super init];
    if (!self) {
        return nil;
    }
    if (width < 64 || height < 64 || width > 4096 || height > 2160) {
        if (error) {
            *error = CDError(@"size must be between 64x64 and 4096x2160");
        }
        return nil;
    }

    _width = width;
    _height = height;
    _data = [NSMutableData dataWithLength:width * height * 4];
    _colorSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    if (!_colorSpace) {
        if (error) {
            *error = CDError(@"cannot create an sRGB color space");
        }
        return nil;
    }

    _context = CGBitmapContextCreate(_data.mutableBytes, width, height, 8, width * 4,
                                     _colorSpace,
                                     kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst);
    if (!_context) {
        if (error) {
            *error = CDError(@"cannot create a BGRA bitmap context");
        }
        return nil;
    }

    _titleFont = CTFontCreateWithName(CFSTR("Menlo-Bold"), 22.0, NULL);
    _counterFont = CTFontCreateWithName(CFSTR("Menlo-Bold"), 58.0, NULL);
    _noteFont = CTFontCreateWithName(CFSTR("Menlo"), 13.0, NULL);
    if (!_titleFont || !_counterFont || !_noteFont) {
        if (error) {
            *error = CDError(@"cannot create CoreText fonts");
        }
        return nil;
    }

    CGFloat whiteComponents[] = {1.0, 1.0, 1.0, 1.0};
    CGFloat blackComponents[] = {0.0, 0.0, 0.0, 1.0};
    CGFloat mutedComponents[] = {0.70, 0.75, 0.82, 1.0};
    _white = CGColorCreate(_colorSpace, whiteComponents);
    _black = CGColorCreate(_colorSpace, blackComponents);
    _muted = CGColorCreate(_colorSpace, mutedComponents);
    if (!_white || !_black || !_muted) {
        if (error) {
            *error = CDError(@"cannot create CoreGraphics colors");
        }
        return nil;
    }

    CGContextSetShouldAntialias(_context, true);
    CGContextSetAllowsAntialiasing(_context, true);
    CGContextSetInterpolationQuality(_context, kCGInterpolationHigh);
    return self;
}

- (void)dealloc
{
    if (_context) {
        CGContextRelease(_context);
    }
    if (_colorSpace) {
        CGColorSpaceRelease(_colorSpace);
    }
    if (_titleFont) {
        CFRelease(_titleFont);
    }
    if (_counterFont) {
        CFRelease(_counterFont);
    }
    if (_noteFont) {
        CFRelease(_noteFont);
    }
    if (_white) {
        CGColorRelease(_white);
    }
    if (_black) {
        CGColorRelease(_black);
    }
    if (_muted) {
        CGColorRelease(_muted);
    }
}

- (const void *)pixels
{
    return _data.bytes;
}

- (size_t)bytesPerRow
{
    return _width * 4;
}

- (void)renderFrame:(uint64_t)frame
{
    const CGFloat width = (CGFloat)_width;
    const CGFloat height = (CGFloat)_height;
    const CGRect full = CGRectMake(0, 0, width, height);

    CGContextSetBlendMode(_context, kCGBlendModeCopy);
    CGContextSetRGBFillColor(_context, 0.025, 0.030, 0.055, 1.0);
    CGContextFillRect(_context, full);
    CGContextSetBlendMode(_context, kCGBlendModeNormal);

    /* Four differently coloured edges make a wrong orientation unmistakable. */
    const CGFloat border = 8.0;
    CGContextSetRGBFillColor(_context, 0.95, 0.12, 0.12, 1.0); /* top: red */
    CGContextFillRect(_context, CGRectMake(0, height - border, width, border));
    CGContextSetRGBFillColor(_context, 0.12, 0.90, 0.35, 1.0); /* bottom: green */
    CGContextFillRect(_context, CGRectMake(0, 0, width, border));
    CGContextSetRGBFillColor(_context, 0.12, 0.35, 1.0, 1.0); /* left: blue */
    CGContextFillRect(_context, CGRectMake(0, 0, border, height));
    CGContextSetRGBFillColor(_context, 1.0, 0.90, 0.10, 1.0); /* right: yellow */
    CGContextFillRect(_context, CGRectMake(width - border, 0, border, height));

    /* A light grid makes motion and scaling obvious in a receiving app. */
    CGContextSetRGBStrokeColor(_context, 0.18, 0.22, 0.32, 0.30);
    CGContextSetLineWidth(_context, 1.0);
    for (CGFloat x = 0; x <= width; x += 40.0) {
        CGContextMoveToPoint(_context, x, 0);
        CGContextAddLineToPoint(_context, x, height);
    }
    for (CGFloat y = 0; y <= height; y += 40.0) {
        CGContextMoveToPoint(_context, 0, y);
        CGContextAddLineToPoint(_context, width, y);
    }
    CGContextStrokePath(_context);

    /* Moving colour bars: x position and hue both change with the frame. */
    for (NSUInteger index = 0; index < 6; index++) {
        double phase = fmod((double)frame * 0.018 + (double)index * 0.16, 1.0);
        double hue = fmod(phase + 0.08 * (double)index, 1.0);
        double x = fmod((double)frame * 10.0 + (double)index * 137.0,
                        (double)_width + 180.0) - 90.0;
        CGFloat y = 36.0 + (CGFloat)index * 34.0;
        CGFloat r = 0.5, g = 0.5, b = 0.5;
        double h = hue * 6.0;
        int sector = (int)h;
        double f = h - (double)sector;
        double p = 0.0, q = 1.0 - f, t = f;
        switch (sector % 6) {
            case 0: r = 1.0; g = t; b = p; break;
            case 1: r = q; g = 1.0; b = p; break;
            case 2: r = p; g = 1.0; b = t; break;
            case 3: r = p; g = q; b = 1.0; break;
            case 4: r = t; g = p; b = 1.0; break;
            default: r = 1.0; g = p; b = q; break;
        }
        CGContextSetRGBFillColor(_context, r, g, b, 1.0);
        CGContextFillRect(_context, CGRectMake((CGFloat)x, y, 150.0, 24.0));
    }

    /* A moving cyan disc crosses the upper part of the frame. */
    {
        CGFloat cx = (CGFloat)fmod((double)frame * 8.0, (double)_width + 180.0) - 90.0;
        CGContextSetRGBFillColor(_context, 0.10, 0.75, 1.0, 0.85);
        CGContextFillEllipseInRect(_context, CGRectMake(cx, height - 210.0, 110.0, 110.0));
    }

    /* A semi-transparent overlay: alpha is present, not just opaque output. */
    CGContextSetRGBFillColor(_context, 0.20, 0.95, 0.45, 0.28);
    CGContextFillRect(_context, CGRectMake(width - 280.0, height - 135.0, 180.0, 88.0));

    /* Fully transparent holes in the lower-right corner. */
    CGContextSetBlendMode(_context, kCGBlendModeClear);
    CGContextFillRect(_context, CGRectMake(width - 215.0, 24.0, 120.0, 86.0));
    CGContextFillEllipseInRect(_context, CGRectMake(width - 85.0, 24.0, 62.0, 86.0));
    CGContextSetBlendMode(_context, kCGBlendModeNormal);

    NSString *title = @"CueDeck Syphon Test";
    NSString *counter = [NSString stringWithFormat:@"FRAME %08llu", (unsigned long long)frame];
    NSString *note = @"moving colour and alpha test / no audio";
    CDDrawText(_context, title, _titleFont, _black, CGPointMake(30.0, height - 55.0));
    CDDrawText(_context, title, _titleFont, _white, CGPointMake(28.0, height - 53.0));
    CDDrawText(_context, counter, _counterFont, _black, CGPointMake(30.0, height - 145.0));
    CDDrawText(_context, counter, _counterFont, _white, CGPointMake(28.0, height - 143.0));
    CDDrawText(_context, note, _noteFont, _muted, CGPointMake(28.0, 32.0));

    /* Readable edge labels: TOP red, BOTTOM green, LEFT blue, RIGHT yellow. */
    CDDrawText(_context, @"TOP", _titleFont, _black, CGPointMake(width / 2.0 - 20.0, height - 34.0));
    CDDrawText(_context, @"TOP", _titleFont, _white, CGPointMake(width / 2.0 - 22.0, height - 32.0));
    CDDrawText(_context, @"BOTTOM", _titleFont, _black, CGPointMake(width / 2.0 - 40.0, 12.0));
    CDDrawText(_context, @"BOTTOM", _titleFont, _white, CGPointMake(width / 2.0 - 42.0, 14.0));
    CDDrawText(_context, @"LEFT", _titleFont, _black, CGPointMake(14.0, height / 2.0 - 12.0));
    CDDrawText(_context, @"LEFT", _titleFont, _white, CGPointMake(12.0, height / 2.0 - 10.0));
    CDDrawText(_context, @"RIGHT", _titleFont, _black, CGPointMake(width - 68.0, height / 2.0 - 12.0));
    CDDrawText(_context, @"RIGHT", _titleFont, _white, CGPointMake(width - 70.0, height / 2.0 - 10.0));

    CGContextSynchronize(_context);
}

@end

/* Syphon Metal publisher. publishBGRA: is the bridge-shaped API. */
@interface CDSyphonPublisher : NSObject
@property(nonatomic, readonly) NSUInteger width;
@property(nonatomic, readonly) NSUInteger height;
@property(nonatomic, readonly) id<MTLDevice> device;
@property(nonatomic, readonly) BOOL hasClients;
@property(nonatomic, readonly) NSDictionary<NSString *, id> *serverDescription;
- (instancetype)initWithName:(NSString *)name
                      width:(NSUInteger)width
                     height:(NSUInteger)height
                    private:(BOOL)isPrivate
                      error:(NSError **)error;
- (BOOL)publishBGRA:(const void *)bytes
              width:(NSUInteger)width
             height:(NSUInteger)height
        bytesPerRow:(NSUInteger)bytesPerRow
              error:(NSError **)error;
- (void)stop;
@end

@implementation CDSyphonPublisher {
    id<MTLDevice> _device;
    id<MTLCommandQueue> _queue;
    SyphonMetalServer *_server;
    id<MTLTexture> _texture;
    NSUInteger _width;
    NSUInteger _height;
}

- (instancetype)initWithName:(NSString *)name
                      width:(NSUInteger)width
                     height:(NSUInteger)height
                    private:(BOOL)isPrivate
                      error:(NSError **)error
{
    self = [super init];
    if (!self) {
        return nil;
    }
    _device = MTLCreateSystemDefaultDevice();
    if (!_device) {
        if (error) {
            *error = CDError(@"Metal is unavailable (MTLCreateSystemDefaultDevice returned nil)");
        }
        return nil;
    }
    _queue = [_device newCommandQueue];
    if (!_queue) {
        if (error) {
            *error = CDError(@"cannot create a Metal command queue");
        }
        return nil;
    }

    NSDictionary *options = isPrivate ? @{SyphonServerOptionIsPrivate: @YES} : nil;
    _server = [[SyphonMetalServer alloc] initWithName:name device:_device options:options];
    if (!_server) {
        if (error) {
            *error = CDError(@"cannot create SyphonMetalServer (check the Metal shader resources in Syphon.framework)");
        }
        return nil;
    }

    _width = width;
    _height = height;
    return self;
}

- (void)dealloc
{
    [self stop];
}

- (void)stop
{
    if (_server) {
        [_server stop];
        _server = nil;
    }
    _texture = nil;
    _queue = nil;
    _device = nil;
}

- (NSUInteger)width
{
    return _width;
}

- (NSUInteger)height
{
    return _height;
}

- (id<MTLDevice>)device
{
    return _device;
}

- (BOOL)hasClients
{
    return _server ? _server.hasClients : NO;
}

- (NSDictionary<NSString *, id> *)serverDescription
{
    return _server ? _server.serverDescription : nil;
}

- (BOOL)publishBGRA:(const void *)bytes
              width:(NSUInteger)width
             height:(NSUInteger)height
        bytesPerRow:(NSUInteger)bytesPerRow
              error:(NSError **)error
{
    if (!bytes || width == 0 || height == 0 || bytesPerRow < width * 4) {
        if (error) {
            *error = CDError(@"invalid BGRA frame dimensions or row length");
        }
        return NO;
    }
    if (!_server || !_queue || !_device) {
        if (error) {
            *error = CDError(@"publisher is stopped");
        }
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
            if (error) {
                *error = CDError(@"cannot create a BGRA Metal texture");
            }
            return NO;
        }
        _width = width;
        _height = height;
    }

    [_texture replaceRegion:MTLRegionMake2D(0, 0, width, height)
               mipmapLevel:0
                 withBytes:bytes
               bytesPerRow:bytesPerRow];

    id<MTLCommandBuffer> commandBuffer = [_queue commandBuffer];
    if (!commandBuffer) {
        if (error) {
            *error = CDError(@"cannot create a Metal command buffer");
        }
        return NO;
    }
    commandBuffer.label = @"CueDeck Syphon Probe publish";
    /*
     * Resolume (OpenGL Syphon client) displays this source vertically flipped
     * when the server publishes with flipped:NO. Syphon's flipped flag makes
     * the server flip vertically into the shared IOSurface; no horizontal
     * transform is applied. This was confirmed by an asymmetric TOP/BOTTOM/
     * LEFT/RIGHT test in Resolume: LEFT stayed left, RIGHT stayed right.
     */
    [_server publishFrameTexture:_texture
                 onCommandBuffer:commandBuffer
                     imageRegion:NSMakeRect(0, 0, (CGFloat)width, (CGFloat)height)
                         flipped:YES];
    [commandBuffer commit];
    [commandBuffer waitUntilCompleted];

    if (commandBuffer.status == MTLCommandBufferStatusError) {
        if (error) {
            *error = commandBuffer.error ?: CDError(@"Metal command buffer failed");
        }
        return NO;
    }
    return YES;
}

@end

static BOOL CDWaitFor(BOOL (^condition)(void), double timeoutSeconds)
{
    double deadline = CDMonotonicNow() + timeoutSeconds;
    while (!gStop && CDMonotonicNow() < deadline) {
        if (condition()) {
            return YES;
        }
        usleep(10 * 1000);
    }
    return condition();
}

static NSData *CDReadClientFrame(SyphonMetalClient *client, NSUInteger *width,
                                 NSUInteger *height, NSError **error)
{
    id<MTLTexture> image = [client newFrameImage];
    if (!image) {
        if (error) {
            *error = CDError(@"SyphonMetalClient.newFrameImage returned nil");
        }
        return nil;
    }
    NSUInteger w = image.width;
    NSUInteger h = image.height;
    if (w == 0 || h == 0) {
        if (error) {
            *error = CDError(@"client returned an empty texture");
        }
        return nil;
    }
    NSUInteger row = w * 4;
    NSMutableData *data = [NSMutableData dataWithLength:row * h];
    @try {
        [image getBytes:data.mutableBytes
           bytesPerRow:row
          fromRegion:MTLRegionMake2D(0, 0, w, h)
         mipmapLevel:0];
    } @catch (NSException *exception) {
        if (error) {
            *error = CDError([NSString stringWithFormat:@"cannot read client texture: %@", exception.reason]);
        }
        return nil;
    }
    if (width) {
        *width = w;
    }
    if (height) {
        *height = h;
    }
    return data;
}

static void CDCountAlpha(const NSData *data, NSUInteger *zeroAlpha, NSUInteger *opaque)
{
    NSUInteger zero = 0;
    NSUInteger full = 0;
    const uint8_t *bytes = data.bytes;
    NSUInteger pixels = data.length / 4;
    for (NSUInteger i = 0; i < pixels; i++) {
        uint8_t alpha = bytes[i * 4 + 3];
        if (alpha == 0) {
            zero++;
        } else if (alpha == 255) {
            full++;
        }
    }
    if (zeroAlpha) {
        *zeroAlpha = zero;
    }
    if (opaque) {
        *opaque = full;
    }
}

static int CDRunSender(NSString *name, double seconds)
{
    NSError *error = nil;
    if (!CDInstallSignalHandlers(&error)) {
        CDPrintError(@"cannot install signal handlers", error);
        return 1;
    }

    CDSyphonPublisher *publisher =
        [[CDSyphonPublisher alloc] initWithName:name
                                           width:kDefaultWidth
                                          height:kDefaultHeight
                                         private:NO
                                           error:&error];
    if (!publisher) {
        CDPrintError(@"cannot start Syphon sender", error);
        return 1;
    }
    CDTestPattern *pattern =
        [[CDTestPattern alloc] initWithWidth:kDefaultWidth height:kDefaultHeight error:&error];
    if (!pattern) {
        CDPrintError(@"cannot create test pattern", error);
        [publisher stop];
        return 1;
    }

    printf("CueDeck Syphon Probe\n");
    printf("server: \"%s\"\n", name.UTF8String);
    printf("frame: %lux%lu BGRA8, %.0f fps, CPU-generated test pattern\n",
           (unsigned long)kDefaultWidth, (unsigned long)kDefaultHeight, kFramesPerSecond);
    if (seconds > 0.0) {
        printf("duration: %.1f s\n", seconds);
    } else {
        printf("duration: until SIGINT/SIGTERM\n");
    }
    printf("audio: none\n");
    printf("Ctrl+C or SIGTERM to stop\n");
    fflush(stdout);

    double started = CDMonotonicNow();
    double nextFrame = started;
    uint64_t frame = 0;
    int status = 0;
    BOOL hadClients = NO;

    while (!gStop) {
        if (seconds > 0.0 && CDMonotonicNow() - started >= seconds) {
            break;
        }

        @autoreleasepool {
            [pattern renderFrame:frame];
            if (![publisher publishBGRA:pattern.pixels
                                   width:kDefaultWidth
                                  height:kDefaultHeight
                             bytesPerRow:pattern.bytesPerRow
                                   error:&error]) {
                CDPrintError(@"publish failed", error);
                status = 1;
                break;
            }
            frame++;
            BOOL hasClients = publisher.hasClients;
            if (hasClients != hadClients) {
                printf("Syphon client %s\n", hasClients ? "attached" : "detached");
                fflush(stdout);
                hadClients = hasClients;
            }
        }

        nextFrame += 1.0 / kFramesPerSecond;
        double now = CDMonotonicNow();
        if (nextFrame < now) {
            nextFrame = now;
        }
        /*
         * Syphon's publishing path is dispatch-based and works without a GUI,
         * but the server answers SyphonServerAnnounceRequest through
         * NSDistributedNotificationCenter. A CLI must pump the run loop or a
         * client started after this sender will not discover it.
         */
        while (!gStop) {
            now = CDMonotonicNow();
            if (now >= nextFrame) {
                break;
            }
            CDPumpRunLoop(MIN(0.05, nextFrame - now));
        }
    }

    [publisher stop];
    if (gStop) {
        printf("\nstopped by signal after %llu frames\n", (unsigned long long)frame);
    } else if (status == 0) {
        printf("stopped after %llu frames\n", (unsigned long long)frame);
    }
    fflush(stdout);
    return status;
}

static int CDRunSelfTest(void)
{
    @autoreleasepool {
        NSError *error = nil;
        if (!CDInstallSignalHandlers(&error)) {
            CDPrintError(@"cannot install signal handlers", error);
            return 1;
        }

        CDSyphonPublisher *publisher =
            [[CDSyphonPublisher alloc] initWithName:@"CueDeck Syphon Self Test"
                                               width:kDefaultWidth
                                              height:kDefaultHeight
                                             private:YES
                                               error:&error];
        if (!publisher) {
            CDPrintError(@"selftest: cannot start private Syphon sender", error);
            return 1;
        }
        CDTestPattern *pattern =
            [[CDTestPattern alloc] initWithWidth:kDefaultWidth height:kDefaultHeight error:&error];
        if (!pattern) {
            CDPrintError(@"selftest: cannot create pattern", error);
            [publisher stop];
            return 1;
        }

        SyphonMetalClient *client =
            [[SyphonMetalClient alloc] initWithServerDescription:publisher.serverDescription
                                                          device:publisher.device
                                                         options:nil
                                                 newFrameHandler:nil];
        if (!client) {
            CDPrintError(@"selftest: cannot create SyphonMetalClient", CDError(@"client init returned nil"));
            [publisher stop];
            return 1;
        }

        int status = 1;
        uint64_t frame = 0;
        BOOL connected = NO;
        do {
            for (int attempt = 0; attempt < 40 && !gStop; attempt++) {
                @autoreleasepool {
                    [pattern renderFrame:frame];
                    if (![publisher publishBGRA:pattern.pixels
                                           width:kDefaultWidth
                                          height:kDefaultHeight
                                     bytesPerRow:pattern.bytesPerRow
                                           error:&error]) {
                        CDPrintError(@"selftest: publish while connecting failed", error);
                        break;
                    }
                    frame++;
                }
                if (client.isValid) {
                    connected = YES;
                    break;
                }
                usleep(25 * 1000);
            }
            if (!connected) {
                CDPrintError(@"selftest: client did not become valid", CDError(@"timeout waiting for server connection"));
                break;
            }

            BOOL gotFrame = NO;
            for (int attempt = 0; attempt < 40 && !gStop; attempt++) {
                if (client.hasNewFrame) {
                    gotFrame = YES;
                    break;
                }
                @autoreleasepool {
                    [pattern renderFrame:frame];
                    if (![publisher publishBGRA:pattern.pixels
                                           width:kDefaultWidth
                                          height:kDefaultHeight
                                     bytesPerRow:pattern.bytesPerRow
                                           error:&error]) {
                        CDPrintError(@"selftest: publish while waiting for frame failed", error);
                        break;
                    }
                    frame++;
                }
                usleep(25 * 1000);
            }
            if (!gotFrame) {
                CDPrintError(@"selftest: no new frame arrived", CDError(@"timeout waiting for frame"));
                break;
            }

            NSUInteger width = 0;
            NSUInteger height = 0;
            NSData *first = CDReadClientFrame(client, &width, &height, &error);
            if (!first) {
                CDPrintError(@"selftest: cannot read first frame", error);
                break;
            }
            if (width != kDefaultWidth || height != kDefaultHeight) {
                CDPrintError(@"selftest: wrong frame size",
                             CDError([NSString stringWithFormat:@"got %lux%lu, expected %lux%lu",
                                      (unsigned long)width, (unsigned long)height,
                                      (unsigned long)kDefaultWidth, (unsigned long)kDefaultHeight]));
                break;
            }

            NSUInteger zeroAlpha = 0;
            NSUInteger opaque = 0;
            CDCountAlpha(first, &zeroAlpha, &opaque);
            if (zeroAlpha == 0 || opaque == 0) {
                CDPrintError(@"selftest: alpha channel not as expected",
                             CDError([NSString stringWithFormat:@"zeroAlpha=%lu opaque=%lu",
                                      (unsigned long)zeroAlpha, (unsigned long)opaque]));
                break;
            }

            BOOL changed = NO;
            for (int attempt = 0; attempt < 20 && !gStop; attempt++) {
                @autoreleasepool {
                    [pattern renderFrame:frame];
                    if (![publisher publishBGRA:pattern.pixels
                                           width:kDefaultWidth
                                          height:kDefaultHeight
                                     bytesPerRow:pattern.bytesPerRow
                                           error:&error]) {
                        CDPrintError(@"selftest: publish for motion check failed", error);
                        break;
                    }
                    frame++;
                }
                if (client.hasNewFrame) {
                    NSUInteger w2 = 0;
                    NSUInteger h2 = 0;
                    NSData *second = CDReadClientFrame(client, &w2, &h2, &error);
                    if (!second) {
                        CDPrintError(@"selftest: cannot read second frame", error);
                        break;
                    }
                    if (second.length == first.length &&
                        memcmp(second.bytes, first.bytes, first.length) != 0) {
                        changed = YES;
                        break;
                    }
                }
                usleep(25 * 1000);
            }
            if (!changed) {
                CDPrintError(@"selftest: frames did not change", CDError(@"two client frames were identical"));
                break;
            }

            printf("SELFTEST PASS: client connected, %lux%lu frames arrived, alpha present, motion detected\n",
                   (unsigned long)width, (unsigned long)height);
            printf("(this proves the local Syphon client path; it does not prove that Resolume displays it)\n");
            status = 0;
        } while (0);

        [client stop];
        [publisher stop];
        if (status != 0) {
            fprintf(stderr, "SELFTEST FAIL\n");
        }
        return status;
    }
}

static int CDRunProbe(NSString *name, double seconds)
{
    @autoreleasepool {
        NSError *error = nil;
        if (!CDInstallSignalHandlers(&error)) {
            CDPrintError(@"cannot install signal handlers", error);
            return 1;
        }

        SyphonServerDirectory *directory = [SyphonServerDirectory sharedDirectory];
        NSDictionary *found = nil;
        double deadline = CDMonotonicNow() + seconds;
        while (!gStop && CDMonotonicNow() < deadline) {
            for (NSDictionary *description in [directory servers]) {
                NSString *serverName = description[SyphonServerDescriptionNameKey];
                if ([serverName isEqualToString:name]) {
                    found = [description copy];
                    break;
                }
            }
            if (found) {
                break;
            }
            CDPumpRunLoop(0.05);
        }
        if (!found) {
            fprintf(stderr, "PROBE FAIL: Syphon server \"%s\" was not found via SyphonServerDirectory within %.1f s\n",
                    name.UTF8String, seconds);
            return 1;
        }

        id<MTLDevice> device = MTLCreateSystemDefaultDevice();
        if (!device) {
            fprintf(stderr, "PROBE FAIL: Metal is unavailable\n");
            return 1;
        }
        SyphonMetalClient *client =
            [[SyphonMetalClient alloc] initWithServerDescription:found
                                                          device:device
                                                         options:nil
                                                 newFrameHandler:nil];
        if (!client) {
            fprintf(stderr, "PROBE FAIL: cannot create SyphonMetalClient\n");
            return 1;
        }

        int status = 1;
        do {
            BOOL valid = CDWaitFor(^{ return client.isValid; }, 3.0);
            if (!valid) {
                fprintf(stderr, "PROBE FAIL: client did not become valid\n");
                break;
            }
            BOOL gotFrame = CDWaitFor(^{ return client.hasNewFrame; }, 3.0);
            if (!gotFrame) {
                fprintf(stderr, "PROBE FAIL: no frame arrived\n");
                break;
            }
            NSUInteger width = 0;
            NSUInteger height = 0;
            NSData *frame = CDReadClientFrame(client, &width, &height, &error);
            if (!frame) {
                CDPrintError(@"PROBE FAIL: cannot read frame", error);
                break;
            }
            printf("PROBE PASS: found \"%s\", received %lux%lu frame\n",
                   name.UTF8String, (unsigned long)width, (unsigned long)height);
            printf("(this proves SDK discovery and a local client read; it does not prove Resolume display)\n");
            status = 0;
        } while (0);

        [client stop];
        return status;
    }
}

static void CDPrintUsage(FILE *out)
{
    fprintf(out,
            "CueDeck Syphon Probe (standalone macOS Metal sender)\n"
            "\n"
            "Usage:\n"
            "  CueDeckSyphonProbe send [--name NAME] [--seconds N]\n"
            "  CueDeckSyphonProbe probe [--name NAME] [--seconds N]\n"
            "  CueDeckSyphonProbe selftest\n"
            "  CueDeckSyphonProbe --help\n"
            "\n"
            "send      Starts a public Syphon Metal server. Default duration: 30 s;\n"
            "          --seconds 0 means run until SIGINT/SIGTERM. No audio, no window.\n"
            "probe     Discovers an existing server with SyphonServerDirectory and reads\n"
            "          one frame with SyphonMetalClient. Default wait: 5 s.\n"
            "selftest  Starts a private server, connects a local client, checks frame\n"
            "          delivery, alpha and motion, then stops. No public server remains.\n"
            "\n"
            "The test frame is %lux%lu BGRA8 at %.0f fps. The sender is not started\n"
            "by the build script.\n",
            (unsigned long)kDefaultWidth, (unsigned long)kDefaultHeight, kFramesPerSecond);
}

static BOOL CDParseOptions(NSArray<NSString *> *arguments, NSUInteger start,
                           NSString **name, double *seconds, BOOL allowIndefinite,
                           NSError **error)
{
    for (NSUInteger i = start; i < arguments.count; i++) {
        NSString *argument = arguments[i];
        if ([argument isEqualToString:@"--name"]) {
            if (++i >= arguments.count || arguments[i].length == 0) {
                if (error) {
                    *error = CDError(@"--name requires a non-empty value");
                }
                return NO;
            }
            *name = arguments[i];
            if ((*name).length > 128) {
                if (error) {
                    *error = CDError(@"--name is limited to 128 characters");
                }
                return NO;
            }
        } else if ([argument isEqualToString:@"--seconds"]) {
            if (++i >= arguments.count) {
                if (error) {
                    *error = CDError(@"--seconds requires a number");
                }
                return NO;
            }
            NSScanner *scanner = [NSScanner scannerWithString:arguments[i]];
            double value = 0.0;
            if (![scanner scanDouble:&value] || !scanner.isAtEnd ||
                !isfinite(value) || value < 0.0 || (!allowIndefinite && value == 0.0)) {
                if (error) {
                    *error = CDError(@"--seconds must be a finite number >= 0");
                }
                return NO;
            }
            *seconds = value;
        } else {
            if (error) {
                *error = CDError([NSString stringWithFormat:@"unknown option: %@", argument]);
            }
            return NO;
        }
    }
    return YES;
}

int main(int argc, const char *argv[])
{
    @autoreleasepool {
        NSArray<NSString *> *arguments = [NSProcessInfo processInfo].arguments;
        if (argc < 2) {
            CDPrintUsage(stderr);
            return 2;
        }
        NSString *command = arguments[1];
        if ([command isEqualToString:@"--help"] || [command isEqualToString:@"-h"] ||
            [command isEqualToString:@"help"]) {
            CDPrintUsage(stdout);
            return 0;
        }

        NSError *error = nil;
        if ([command isEqualToString:@"send"]) {
            NSString *name = kDefaultServerName;
            double seconds = kSendSeconds;
            if (!CDParseOptions(arguments, 2, &name, &seconds, YES, &error)) {
                CDPrintError(@"bad arguments", error);
                CDPrintUsage(stderr);
                return 2;
            }
            return CDRunSender(name, seconds);
        }
        if ([command isEqualToString:@"probe"]) {
            NSString *name = kDefaultServerName;
            double seconds = kProbeSeconds;
            if (!CDParseOptions(arguments, 2, &name, &seconds, NO, &error)) {
                CDPrintError(@"bad arguments", error);
                CDPrintUsage(stderr);
                return 2;
            }
            return CDRunProbe(name, seconds);
        }
        if ([command isEqualToString:@"selftest"]) {
            if (arguments.count != 2) {
                CDPrintError(@"bad arguments", CDError(@"selftest takes no options"));
                return 2;
            }
            return CDRunSelfTest();
        }

        CDPrintError(@"unknown command", CDError(command));
        CDPrintUsage(stderr);
        return 2;
    }
}
