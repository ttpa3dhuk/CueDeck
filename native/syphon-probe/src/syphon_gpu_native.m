/*
 * In-process Syphon GPU publisher for Electron 33.4.11.
 *
 * Electron gives the main process a raw IOSurface* in
 * OffscreenSharedTexture.textureInfo.sharedTextureHandle. That pointer is only
 * valid in this process; this dylib is loaded into the Electron main process
 * via Koffi and imports the surface into an MTLTexture without CPU pixels.
 *
 * The Metal command buffer is committed asynchronously. The JS owner must keep
 * the OffscreenSharedTexture alive until cuedeck_gpu_publisher_poll returns
 * success/error for that frame. There is no GPU wait on the JS/main thread.
 *
 * There is no IOSurface ID, no global surface, no helper process and no raw
 * pointer IPC. The abandoned ID transport is kept separately as FAIL evidence.
 */
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <IOSurface/IOSurface.h>
#import <CoreVideo/CoreVideo.h>
#import <Syphon/Syphon.h>

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define CDG_PIXEL_BGRA 1u
#define CDG_PIXEL_RGBA 2u
#define CDG_RESULT_BYTES 16u

static void CDGError(char *out, size_t len, NSString *message) {
    if (!out || len == 0) return;
    strncpy(out, message.UTF8String ?: "unknown error", len - 1);
    out[len - 1] = '\0';
}

static uint32_t CDGMapIOSurfacePixelFormat(OSType actual) {
    if (actual == (OSType)kCVPixelFormatType_32BGRA) return CDG_PIXEL_BGRA;
    if (actual == (OSType)kCVPixelFormatType_32RGBA) return CDG_PIXEL_RGBA;
    return 0;
}

static MTLPixelFormat CDGMapMetalPixelFormat(uint32_t format) {
    return format == CDG_PIXEL_BGRA ? MTLPixelFormatBGRA8Unorm
         : format == CDG_PIXEL_RGBA ? MTLPixelFormatRGBA8Unorm
         : MTLPixelFormatInvalid;
}

@interface CDGPub : NSObject
@property(nonatomic, readonly) BOOL fatal;
- (instancetype)initWithName:(NSString *)name
                    private:(BOOL)isPrivate
                      flipY:(BOOL)flipY
                      error:(char *)err
                     errlen:(size_t)errlen;
- (NSDictionary<NSString *, id> *)serverDescription;
- (int)submitHandle:(const uint8_t *)handle
             length:(size_t)length
              width:(uint32_t)width
             height:(uint32_t)height
             stride:(uint32_t)stride
        pixelFormat:(uint32_t)pixelFormat
            frameId:(uint64_t)frameId
              error:(char *)err
             errlen:(size_t)errlen;
- (int)pollOut:(uint8_t *)out length:(size_t)length;
- (int)pending;
- (void)shutdown;
@end

@implementation CDGPub {
    id<MTLDevice> _device;
    id<MTLCommandQueue> _queue;
    SyphonMetalServer *_server;
    NSLock *_lock;
    BOOL _flipY;
    BOOL _closing;
    NSUInteger _pending;
    NSMutableArray<NSData *> *_completed;
}

- (instancetype)initWithName:(NSString *)name
                    private:(BOOL)isPrivate
                      flipY:(BOOL)flipY
                      error:(char *)err
                     errlen:(size_t)errlen {
    self = [super init];
    if (!self) return nil;
    _device = MTLCreateSystemDefaultDevice();
    if (!_device) {
        CDGError(err, errlen, @"Metal is unavailable");
        return nil;
    }
    _queue = [_device newCommandQueue];
    if (!_queue) {
        CDGError(err, errlen, @"cannot create Metal command queue");
        return nil;
    }
    NSDictionary *options = isPrivate ? @{SyphonServerOptionIsPrivate: @YES} : nil;
    _server = [[SyphonMetalServer alloc] initWithName:name device:_device options:options];
    if (!_server) {
        CDGError(err, errlen, @"cannot create SyphonMetalServer");
        return nil;
    }
    _flipY = flipY;
    _lock = [[NSLock alloc] init];
    _completed = [[NSMutableArray alloc] init];
    return self;
}

- (void)dealloc {
    if (_server) { [_server stop]; _server = nil; }
    _queue = nil;
    _device = nil;
}

- (BOOL)fatal { return NO; }
- (NSDictionary<NSString *, id> *)serverDescription {
    return _server ? _server.serverDescription : nil;
}

- (int)submitHandle:(const uint8_t *)handle
             length:(size_t)length
              width:(uint32_t)width
             height:(uint32_t)height
             stride:(uint32_t)stride
        pixelFormat:(uint32_t)pixelFormat
            frameId:(uint64_t)frameId
              error:(char *)err
             errlen:(size_t)errlen {
    if (!handle || length != sizeof(uintptr_t) || !width || !height || !stride ||
        !frameId || CDGMapMetalPixelFormat(pixelFormat) == MTLPixelFormatInvalid) {
        CDGError(err, errlen, @"invalid GPU submit arguments");
        return -1;
    }
    uintptr_t raw = 0;
    memcpy(&raw, handle, sizeof(raw));
    IOSurfaceRef surface = (IOSurfaceRef)raw;
    if (!surface) {
        CDGError(err, errlen, @"null IOSurface pointer");
        return -1;
    }
    [_lock lock];
    if (_closing) {
        [_lock unlock];
        CDGError(err, errlen, @"publisher is shutting down");
        return -1;
    }
    if (_pending != 0) {
        [_lock unlock];
        CDGError(err, errlen, @"one GPU frame is already in flight");
        return -2;
    }
    _pending = 1;
    [_lock unlock];

    if (IOSurfaceGetWidth(surface) != width || IOSurfaceGetHeight(surface) != height ||
        IOSurfaceGetBytesPerRow(surface) != stride) {
        [_lock lock]; _pending = 0; [_lock unlock];
        CDGError(err, errlen, @"IOSurface geometry does not match");
        return -1;
    }
    uint32_t actualPixelFormat = CDGMapIOSurfacePixelFormat(IOSurfaceGetPixelFormat(surface));
    if (actualPixelFormat == 0 || actualPixelFormat != pixelFormat) {
        [_lock lock]; _pending = 0; [_lock unlock];
        CDGError(err, errlen, @"IOSurface pixel format does not match");
        return -1;
    }

    CFRetain(surface); // held until this frame's command buffer completes
    MTLTextureDescriptor *descriptor =
        [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:CDGMapMetalPixelFormat(pixelFormat)
                                                           width:width height:height mipmapped:NO];
    descriptor.usage = MTLTextureUsageShaderRead;
    id<MTLTexture> texture = [_device newTextureWithDescriptor:descriptor iosurface:surface plane:0];
    if (!texture) {
        CFRelease(surface);
        [_lock lock]; _pending = 0; [_lock unlock];
        CDGError(err, errlen, @"cannot create MTLTexture from IOSurface");
        return -1;
    }
    id<MTLCommandBuffer> commandBuffer = [_queue commandBuffer];
    if (!commandBuffer) {
        CFRelease(surface);
        [_lock lock]; _pending = 0; [_lock unlock];
        CDGError(err, errlen, @"cannot create Metal command buffer");
        return -1;
    }

    __block CDGPub *blockSelf = self;
    [commandBuffer addCompletedHandler:^(id<MTLCommandBuffer> _Nonnull completed) {
        int status = completed.status == MTLCommandBufferStatusError ? 3 : 0;
        CFRelease(surface);
        // Texture is released by ARC after this block; the command buffer has
        // completed, so the source IOSurface is no longer read.
        (void)texture;
        [blockSelf completeFrame:frameId status:status];
    }];
    commandBuffer.label = @"CueDeck Syphon in-process GPU publish";
    [_server publishFrameTexture:texture
                 onCommandBuffer:commandBuffer
                     imageRegion:NSMakeRect(0, 0, (CGFloat)width, (CGFloat)height)
                         flipped:_flipY];
    [commandBuffer commit];
    return 0;
}

- (void)completeFrame:(uint64_t)frameId status:(int)status {
    NSMutableData *result = [NSMutableData dataWithLength:CDG_RESULT_BYTES];
    uint8_t *p = (uint8_t *)result.mutableBytes;
    for (int i = 0; i < 8; i++) p[i] = (uint8_t)((frameId >> (8 * i)) & 0xff);
    p[8] = (uint8_t)(status & 0xff);
    p[9] = (uint8_t)((status >> 8) & 0xff);
    p[10] = (uint8_t)((status >> 16) & 0xff);
    p[11] = (uint8_t)((status >> 24) & 0xff);
    [_lock lock];
    _pending = 0;
    [_completed addObject:result];
    // Do not stop SyphonMetalServer from a Metal completion handler. The
    // retained object's dealloc (after any pending block ends) or shutdown
    // with no pending work owns teardown.
    [_lock unlock];
}

- (int)pollOut:(uint8_t *)out length:(size_t)length {
    if (!out || length < CDG_RESULT_BYTES) return -1;
    [_lock lock];
    if (_completed.count == 0) {
        [_lock unlock];
        return 0;
    }
    NSData *result = _completed.firstObject;
    [_completed removeObjectAtIndex:0];
    memcpy(out, result.bytes, CDG_RESULT_BYTES);
    [_lock unlock];
    return 1;
}

- (int)pending {
    [_lock lock];
    int value = (int)_pending;
    [_lock unlock];
    return value;
}

- (void)shutdown {
    [_lock lock];
    _closing = YES;
    if (_pending == 0 && _server) {
        [_server stop];
        _server = nil;
    }
    [_lock unlock];
}

@end

uint32_t cuedeck_gpu_surface_stride(const uint8_t *handle, size_t length) {
    if (!handle || length != sizeof(uintptr_t)) return 0;
    uintptr_t raw = 0;
    memcpy(&raw, handle, sizeof(raw));
    IOSurfaceRef surface = (IOSurfaceRef)raw;
    return surface ? (uint32_t)IOSurfaceGetBytesPerRow(surface) : 0;
}

#pragma mark - Non-global ABI selftest

static void CDGPubPixel(uint8_t *p, uint8_t b, uint8_t g, uint8_t r, uint8_t a) {
    p[0] = b; p[1] = g; p[2] = r; p[3] = a;
}
static void CDGPubRect(uint8_t *p, NSUInteger w, NSUInteger h,
                       NSUInteger x0, NSUInteger y0, NSUInteger rw, NSUInteger rh,
                       uint8_t b, uint8_t g, uint8_t r, uint8_t a) {
    for (NSUInteger y = y0; y < y0 + rh && y < h; y++)
        for (NSUInteger x = x0; x < x0 + rw && x < w; x++)
            CDGPubPixel(p + (y * w + x) * 4, b, g, r, a);
}

static IOSurfaceRef CDGPubFixtureSurface(NSUInteger width, NSUInteger height) {
    // Deliberately NO kIOSurfaceIsGlobal. This is the positive-control shape
    // used by Chromium 130 (ui/gfx/mac/io_surface.cc).
    NSDictionary *attrs = @{
        (id)kIOSurfaceWidth: @(width),
        (id)kIOSurfaceHeight: @(height),
        (id)kIOSurfacePixelFormat: @(kCVPixelFormatType_32BGRA),
        (id)kIOSurfaceBytesPerElement: @(4),
    };
    IOSurfaceRef surface = IOSurfaceCreate((__bridge CFDictionaryRef)attrs);
    if (!surface) return NULL;
    if (IOSurfaceLock(surface, 0, NULL) != 0) { CFRelease(surface); return NULL; }
    uint8_t *p = (uint8_t *)IOSurfaceGetBaseAddress(surface);
    NSUInteger stride = IOSurfaceGetBytesPerRow(surface);
    for (NSUInteger y = 0; y < height; y++) memset(p + y * stride, 0, width * 4);
    CDGPubRect(p, stride / 4, height, 0, 0, width / 2, height / 2, 0, 0, 255, 255);
    CDGPubRect(p, stride / 4, height, width / 2, 0, width - width / 2, height / 2, 0, 255, 0, 255);
    CDGPubRect(p, stride / 4, height, 0, height / 2, width / 2, height - height / 2, 255, 0, 0, 255);
    CDGPubRect(p, stride / 4, height, width / 2, height / 2, width - width / 2, height - height / 2, 0, 255, 255, 255);
    CDGPubRect(p, stride / 4, height, width / 2 - 8, height / 2 - 8, 16, 16, 0, 0, 0, 0);
    CDGPubRect(p, stride / 4, height, 8, height / 2 - 8, 16, 16, 16, 32, 64, 128);
    IOSurfaceUnlock(surface, 0, NULL);
    return surface;
}

static BOOL CDGPubIsColor(const uint8_t *p, char wanted) {
    if (p[3] < 250) return NO;
    switch (wanted) {
        case 'R': return p[2] > 220 && p[1] < 40 && p[0] < 40;
        case 'G': return p[1] > 220 && p[2] < 40 && p[0] < 40;
        case 'B': return p[0] > 220 && p[2] < 40 && p[1] < 40;
        case 'Y': return p[2] > 220 && p[1] > 220 && p[0] < 40;
        default: return NO;
    }
}

int cuedeck_gpu_selftest(int flipY) {
    @autoreleasepool {
        char err[256] = {0};
        const NSUInteger width = 96, height = 64;
        CDGPub *pub = [[CDGPub alloc] initWithName:@"CueDeck Syphon ABI Selftest"
                                           private:YES flipY:flipY != 0 error:err errlen:sizeof(err)];
        if (!pub) { fprintf(stderr, "ABI selftest: %s\n", err); return 1; }
        IOSurfaceRef surface = CDGPubFixtureSurface(width, height);
        if (!surface) { [pub shutdown]; fprintf(stderr, "ABI selftest: surface failed\n"); return 1; }
        SyphonMetalClient *client =
            [[SyphonMetalClient alloc] initWithServerDescription:pub.serverDescription
                                                          device:MTLCreateSystemDefaultDevice()
                                                         options:nil newFrameHandler:nil];
        if (!client) { CFRelease(surface); [pub shutdown]; fprintf(stderr, "ABI selftest: client failed\n"); return 1; }
        for (int i = 0; i < 100 && !client.isValid; i++) usleep(10 * 1000);
        uintptr_t raw = (uintptr_t)surface;
        int submit = [pub submitHandle:(const uint8_t *)&raw length:sizeof(raw)
                                 width:width height:height
                                stride:IOSurfaceGetBytesPerRow(surface)
                           pixelFormat:CDG_PIXEL_BGRA frameId:1 error:err errlen:sizeof(err)];
        int status = 1;
        if (submit != 0) {
            fprintf(stderr, "ABI selftest: submit: %s\n", err);
        } else {
            uint8_t out[CDG_RESULT_BYTES];
            int got = 0;
            for (int i = 0; i < 500; i++) {
                got = [pub pollOut:out length:sizeof(out)];
                if (got != 0) break;
                usleep(10 * 1000);
            }
            if (got != 1 || out[8] != 0) {
                fprintf(stderr, "ABI selftest: async completion failed (poll=%d status=%u)\n", got, out[8]);
            } else {
                for (int i = 0; i < 120 && !client.hasNewFrame; i++) usleep(10 * 1000);
                id<MTLTexture> image = [client newFrameImage];
                if (!image) {
                    fprintf(stderr, "ABI selftest: no client frame\n");
                } else {
                    NSUInteger w = image.width, h = image.height, row = w * 4;
                    NSMutableData *data = [NSMutableData dataWithLength:row * h];
                    @try {
                        [image getBytes:data.mutableBytes bytesPerRow:row
                             fromRegion:MTLRegionMake2D(0, 0, w, h) mipmapLevel:0];
                        const uint8_t *p = data.bytes;
                        char eTL = flipY ? 'B' : 'R', eTR = flipY ? 'Y' : 'G';
                        char eBL = flipY ? 'R' : 'B', eBR = flipY ? 'G' : 'Y';
                        BOOL ok = CDGPubIsColor(p + (2 * w + 2) * 4, eTL) &&
                                  CDGPubIsColor(p + (2 * w + w - 3) * 4, eTR) &&
                                  CDGPubIsColor(p + ((h - 3) * w + 2) * 4, eBL) &&
                                  CDGPubIsColor(p + ((h - 3) * w + w - 3) * 4, eBR);
                        NSUInteger z = 0, half = 0;
                        for (NSUInteger i = 0; i < w * h; i++) {
                            uint8_t a = p[i * 4 + 3];
                            if (a == 0) z++;
                            if (a == 128) half++;
                        }
                        if (ok && z && half) {
                            printf("GPU-ABI-SELFTEST PASS: non-global IOSurface -> MTLTexture -> Syphon -> Metal client, flipY=%d\n", flipY ? 1 : 0);
                            printf("(in-process C ABI; this is the chosen path; Resolume/OpenGL orientation still requires manual check)\n");
                            status = 0;
                        } else {
                            fprintf(stderr, "ABI selftest: orientation/alpha mismatch (flipY=%d zero=%lu half=%lu)\n",
                                    flipY ? 1 : 0, (unsigned long)z, (unsigned long)half);
                        }
                    } @catch (NSException *e) {
                        fprintf(stderr, "ABI selftest: readback for test only failed: %s\n", e.reason.UTF8String);
                    }
                }
            }
        }
        [client stop];
        CFRelease(surface);
        [pub shutdown];
        return status;
    }
}

#pragma mark - C ABI

void *cuedeck_gpu_publisher_create(const char *name, int is_private, int flip_y,
                                   char *err, size_t errlen) {
    @autoreleasepool {
        NSString *serverName = name ? [NSString stringWithUTF8String:name] : @"CueDeck Syphon GPU";
        if (!serverName) serverName = @"CueDeck Syphon GPU";
        CDGPub *pub = [[CDGPub alloc] initWithName:serverName private:is_private != 0
                                             flipY:flip_y != 0 error:err errlen:errlen];
        return pub ? (void *)CFBridgingRetain(pub) : NULL;
    }
}

int cuedeck_gpu_publisher_submit(void *opaque, const uint8_t *handle, size_t length,
                                 uint32_t width, uint32_t height, uint32_t stride,
                                 uint32_t pixel_format, uint64_t frame_id,
                                 char *err, size_t errlen) {
    if (!opaque) return -1;
    CDGPub *pub = (__bridge CDGPub *)opaque;
    return [pub submitHandle:handle length:length width:width height:height stride:stride
                 pixelFormat:pixel_format frameId:frame_id error:err errlen:errlen];
}

int cuedeck_gpu_publisher_poll(void *opaque, uint8_t *out, size_t length) {
    if (!opaque) return -1;
    CDGPub *pub = (__bridge CDGPub *)opaque;
    return [pub pollOut:out length:length];
}

int cuedeck_gpu_publisher_pending(void *opaque) {
    if (!opaque) return -1;
    CDGPub *pub = (__bridge CDGPub *)opaque;
    return [pub pending];
}

void cuedeck_gpu_publisher_destroy(void *opaque) {
    if (!opaque) return;
    CDGPub *pub = (__bridge_transfer CDGPub *)opaque;
    [pub shutdown];
}
