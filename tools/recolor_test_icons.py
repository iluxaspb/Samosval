"""Generate red TEST-only PWA icons from the original blue icons; stdlib only."""
from __future__ import annotations

import binascii
import struct
import zlib
from pathlib import Path

SIGNATURE = b'\x89PNG\r\n\x1a\n'


def _chunk(name: bytes, payload: bytes) -> bytes:
    body = name + payload
    return struct.pack('>I', len(payload)) + body + struct.pack('>I', binascii.crc32(body) & 0xFFFFFFFF)


def _decode(source: bytes) -> tuple[int, int, int, list[bytearray]]:
    if not source.startswith(SIGNATURE):
        raise ValueError('TEST icon is not PNG')
    pos = len(SIGNATURE)
    idat = []
    ihdr = None
    while pos < len(source):
        if pos + 12 > len(source):
            raise ValueError('Invalid PNG chunk')
        n = struct.unpack('>I', source[pos:pos+4])[0]
        tag = source[pos+4:pos+8]
        data = source[pos+8:pos+8+n]
        checksum = struct.unpack('>I', source[pos+8+n:pos+12+n])[0]
        if binascii.crc32(tag + data) & 0xFFFFFFFF != checksum:
            raise ValueError('PNG CRC mismatch')
        pos += 12+n
        if tag == b'IHDR':
            ihdr = struct.unpack('>IIBBBBB', data)
        elif tag == b'IDAT':
            idat.append(data)
        elif tag == b'IEND':
            break
    if ihdr is None:
        raise ValueError('Missing PNG header')
    width, height, depth, kind, compression, filtering, interlace = ihdr
    if depth != 8 or kind not in (2, 6) or compression or filtering or interlace:
        raise ValueError('Unexpected TEST PNG layout')
    channels = 3 if kind == 2 else 4
    stride = width * channels
    raw = zlib.decompress(b''.join(idat))
    if len(raw) != height * (stride+1):
        raise ValueError('Truncated TEST PNG data')
    rows = []
    offset = 0
    prior = bytearray(stride)
    for _ in range(height):
        method = raw[offset]
        pixels = bytearray(raw[offset+1:offset+1+stride])
        offset += stride+1
        for x in range(stride):
            a = pixels[x-channels] if x >= channels else 0
            b = prior[x]
            c = prior[x-channels] if x >= channels else 0
            if method == 0:
                predictor = 0
            elif method == 1:
                predictor = a
            elif method == 2:
                predictor = b
            elif method == 3:
                predictor = (a+b)//2
            elif method == 4:
                p = a+b-c
                distances = [abs(p-a), abs(p-b), abs(p-c)]
                predictor = [a, b, c][distances.index(min(distances))]
            else:
                raise ValueError('Unsupported PNG filter')
            pixels[x] = (pixels[x] + predictor) & 255
        rows.append(pixels)
        prior = pixels
    return width, height, channels, rows


def recolour(source: bytes, expected_size: int) -> bytes:
    width, height, channels, rows = _decode(source)
    if width != expected_size or height != expected_size:
        raise ValueError('Unexpected PWA icon dimensions')
    changed = 0
    out = bytearray()
    for row in rows:
        for i in range(0, len(row), channels):
            red, green, blue = row[i:i+3]
            # Recolour saturated blue body panels only. Preserve the dark
            # background, pale windshield, gray wheels and sharp silhouette.
            if blue > 195 and blue - red > 100 and blue - green > 45:
                if red < 85:
                    row[i:i+3] = bytes((239, 68, 68))      # dump bed
                else:
                    row[i:i+3] = bytes((248, 113, 113))   # cab
                changed += 1
        out += b'\x00' + row
    if changed < expected_size:
        raise ValueError('No blue vehicle was found to recolour')
    kind = 2 if channels == 3 else 6
    ihdr = struct.pack('>IIBBBBB', width, height, 8, kind, 0, 0, 0)
    png = SIGNATURE + _chunk(b'IHDR', ihdr) + _chunk(b'IDAT', zlib.compress(bytes(out), level=9)) + _chunk(b'IEND', b'')
    _decode(png)  # Verify exact PNG format and CRC before publishing.
    return png


def build_icons(icon_dir: Path) -> None:
    for size in (192, 512):
        source = icon_dir / f'icon-{size}.png'
        target = icon_dir / f'icon-test-red-{size}.png'
        result = recolour(source.read_bytes(), size)
        if not target.exists() or target.read_bytes() != result:
            target.write_bytes(result)


if __name__ == '__main__':
    build_icons(Path(__file__).resolve().parents[1] / 'test-app/icons')
