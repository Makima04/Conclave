#!/usr/bin/env python3
"""Extract character card JSON from SillyTavern PNG files."""
import struct, base64, json, sys, zlib, os

def extract_card_json(png_path: str) -> dict:
    with open(png_path, 'rb') as f:
        data = f.read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'Not a valid PNG file'
    pos = 8
    while pos < len(data):
        length = struct.unpack('>I', data[pos:pos+4])[0]
        chunk_type = data[pos+4:pos+8].decode('ascii', errors='replace')
        chunk_data = data[pos+8:pos+8+length]
        if chunk_type in ('tEXt', 'iTXt'):
            null_pos = chunk_data.find(b'\x00')
            keyword = chunk_data[:null_pos].decode('latin-1')
            text = chunk_data[null_pos+1:].decode('latin-1')
            if keyword.lower() in ('ccv3', 'chara'):
                decoded = base64.b64decode(text)
                try:
                    decoded = zlib.decompress(decoded)
                except zlib.error:
                    pass
                return json.loads(decoded)
        pos += 12 + length
    raise ValueError('No CCv3/Chara chunk found in PNG')

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f'Usage: python3 {sys.argv[0]} <card.png> [output.json]')
        sys.exit(1)
    card = extract_card_json(sys.argv[1])
    out_path = sys.argv[2] if len(sys.argv) > 2 else os.path.splitext(sys.argv[1])[0] + '.json'
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(card, f, ensure_ascii=False, indent=2)
    print(f'Extracted to: {out_path} ({len(json.dumps(card))} chars)')
