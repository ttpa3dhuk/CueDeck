/*
 * Binary frame protocol shared by CueDeck's main process and the native Syphon
 * helper. Keep offsets and constants in sync with
 * src/main/syphon-bridge-protocol.ts.
 *
 * Frame: 40-byte little-endian header followed by exactly payloadLength bytes.
 * Ack:   24-byte little-endian header.
 */
#ifndef CUEDECK_SYPHON_FRAME_PROTOCOL_H
#define CUEDECK_SYPHON_FRAME_PROTOCOL_H

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define CD_FRAME_MAGIC "CDSB"
#define CD_ACK_MAGIC "CDSA"
#define CD_PROTOCOL_VERSION 1u
#define CD_FRAME_HEADER_BYTES 40u
#define CD_ACK_HEADER_BYTES 24u

#define CD_FLAG_PREMULTIPLIED 1u
#define CD_FLAG_TOP_LEFT 2u
#define CD_FLAGS_KNOWN (CD_FLAG_PREMULTIPLIED | CD_FLAG_TOP_LEFT)

#define CD_MIN_DIMENSION 16u
#define CD_MAX_WIDTH 4096u
#define CD_MAX_HEIGHT 2160u
#define CD_MAX_STRIDE 16384u
#define CD_MAX_PAYLOAD (64u * 1024u * 1024u)

#define CD_STATUS_PUBLISHED 0u
#define CD_STATUS_READY 1u
#define CD_STATUS_BAD_FRAME 2u
#define CD_STATUS_GPU_TIMEOUT 3u
#define CD_STATUS_INTERNAL 4u
#define CD_STATUS_PROTOCOL_ERROR 5u

typedef struct cd_frame_header {
    uint32_t flags;
    uint32_t width;
    uint32_t height;
    uint32_t stride;
    uint32_t payload_length;
    uint64_t frame_id;
} cd_frame_header;

static inline uint16_t cd_read_u16(const uint8_t *p) {
    return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

static inline uint32_t cd_read_u32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static inline uint64_t cd_read_u64(const uint8_t *p) {
    uint64_t value = 0;
    for (int i = 7; i >= 0; --i) {
        value = (value << 8) | (uint64_t)p[i];
    }
    return value;
}

static inline void cd_write_u16(uint8_t *p, uint16_t value) {
    p[0] = (uint8_t)(value & 0xffu);
    p[1] = (uint8_t)((value >> 8) & 0xffu);
}

static inline void cd_write_u32(uint8_t *p, uint32_t value) {
    p[0] = (uint8_t)(value & 0xffu);
    p[1] = (uint8_t)((value >> 8) & 0xffu);
    p[2] = (uint8_t)((value >> 16) & 0xffu);
    p[3] = (uint8_t)((value >> 24) & 0xffu);
}

static inline void cd_write_u64(uint8_t *p, uint64_t value) {
    for (int i = 0; i < 8; ++i) {
        p[i] = (uint8_t)((value >> (8 * i)) & 0xffu);
    }
}

static inline uint32_t cd_fnv1a(const uint8_t *p, size_t length) {
    uint32_t hash = 0x811c9dc5u;
    for (size_t i = 0; i < length; ++i) {
        hash ^= (uint32_t)p[i];
        hash *= 0x01000193u;
    }
    return hash;
}

static inline uint32_t cd_frame_checksum(const uint8_t *header) {
    return cd_fnv1a(header, 36);
}

static inline int cd_validate_shape(uint32_t width, uint32_t height,
                                    uint32_t stride, uint32_t payload,
                                    char *why, size_t why_length) {
    if (width < CD_MIN_DIMENSION || width > CD_MAX_WIDTH ||
        height < CD_MIN_DIMENSION || height > CD_MAX_HEIGHT) {
        if (why && why_length) snprintf(why, why_length, "frame dimensions out of range");
        return -1;
    }
    if (stride < width * 4u || stride > CD_MAX_STRIDE || (stride % 4u) != 0u) {
        if (why && why_length) snprintf(why, why_length, "invalid stride");
        return -1;
    }
    if (payload > CD_MAX_PAYLOAD || payload != stride * height) {
        if (why && why_length) snprintf(why, why_length, "invalid payload length");
        return -1;
    }
    if ((uint64_t)width * (uint64_t)height * 4u > CD_MAX_PAYLOAD) {
        if (why && why_length) snprintf(why, why_length, "frame exceeds payload limit");
        return -1;
    }
    return 0;
}

/* Returns 0 on success, -1 on malformed header. The frame id is filled when
 * the first 36 bytes are readable, even if the rest of the header is invalid. */
static inline int cd_parse_frame_header(const uint8_t *buf, size_t length,
                                        cd_frame_header *out,
                                        char *why, size_t why_length) {
    if (length != CD_FRAME_HEADER_BYTES) {
        if (why && why_length) snprintf(why, why_length, "short header");
        return -1;
    }
    if (memcmp(buf, CD_FRAME_MAGIC, 4) != 0) {
        if (why && why_length) snprintf(why, why_length, "bad frame magic");
        return -1;
    }
    if (cd_read_u16(buf + 4) != CD_PROTOCOL_VERSION) {
        if (why && why_length) snprintf(why, why_length, "unsupported protocol version");
        return -1;
    }
    if (cd_read_u16(buf + 6) != CD_FRAME_HEADER_BYTES) {
        if (why && why_length) snprintf(why, why_length, "bad header length");
        return -1;
    }
    if (cd_read_u32(buf + 36) != cd_frame_checksum(buf)) {
        if (why && why_length) snprintf(why, why_length, "bad header checksum");
        return -1;
    }
    uint32_t flags = cd_read_u32(buf + 8);
    if ((flags & ~CD_FLAGS_KNOWN) != 0u || (flags & CD_FLAG_PREMULTIPLIED) == 0u) {
        if (why && why_length) snprintf(why, why_length, "unsupported frame flags");
        return -1;
    }
    uint32_t width = cd_read_u32(buf + 12);
    uint32_t height = cd_read_u32(buf + 16);
    uint32_t stride = cd_read_u32(buf + 20);
    uint32_t payload = cd_read_u32(buf + 24);
    if (cd_validate_shape(width, height, stride, payload, why, why_length) != 0) return -1;
    uint64_t frame_id = cd_read_u64(buf + 28);
    if (frame_id == 0u) {
        if (why && why_length) snprintf(why, why_length, "frame id must be non-zero");
        return -1;
    }
    out->flags = flags;
    out->width = width;
    out->height = height;
    out->stride = stride;
    out->payload_length = payload;
    out->frame_id = frame_id;
    return 0;
}

static inline void cd_encode_ack(uint8_t out[CD_ACK_HEADER_BYTES],
                                 uint32_t status, uint64_t frame_id,
                                 uint32_t detail) {
    memcpy(out, CD_ACK_MAGIC, 4);
    cd_write_u16(out + 4, CD_PROTOCOL_VERSION);
    cd_write_u16(out + 6, CD_ACK_HEADER_BYTES);
    cd_write_u32(out + 8, status);
    cd_write_u64(out + 12, frame_id);
    cd_write_u32(out + 20, detail);
}

#endif
