"""Publish the original blue icons as production PWA icons; stdlib only, byte-exact copy."""
from __future__ import annotations

import struct
import binascii
from pathlib import Path

SIGNATURE = b'\x89PNG\r\n\x1a\n'


def _decode(source: bytes) -> tuple[int, int]:
    if not source.startswith(SIGNATURE):
        raise ValueError('PRODUCTION icon is not PNG')
    pos = len(SIGNATURE)
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
        elif tag == b'IEND':
            break
    if ihdr is None:
        raise ValueError('Missing PNG header')
    width, height, depth, kind, compression, filtering, interlace = ihdr
    if depth != 8 or kind not in (2, 6) or compression or filtering or interlace:
        raise ValueError('Unexpected PRODUCTION PNG layout')
    return width, height


def copy_blue(source: bytes, expected_size: int) -> bytes:
    width, height = _decode(source)
    if width != expected_size or height != expected_size:
        raise ValueError('Unexpected PWA icon dimensions')
    _decode(source)  # Verify exact PNG format and CRC before publishing.
    return source


def build_icons(icon_dir: Path) -> None:
    for size in (192, 512):
        source = icon_dir / f'icon-{size}.png'
        target = icon_dir / f'icon-production-blue-{size}.png'
        result = copy_blue(source.read_bytes(), size)
        if not target.exists() or target.read_bytes() != result:
            target.write_bytes(result)


if __name__ == '__main__':
    build_icons(Path(__file__).resolve().parents[1] / 'working-test/icons')
