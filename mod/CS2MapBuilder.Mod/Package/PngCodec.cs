using System;
using System.IO;
using System.IO.Compression;

namespace CS2MapBuilder.Package
{
    /// <summary>
    /// Minimal PNG decoder/encoder (no game dependencies). Decodes non-interlaced greyscale, grey+alpha,
    /// RGB and RGBA images at 8 or 16 bits per channel into a <see cref="GrayImage"/> (first channel only,
    /// normalised to 0..65535). Encodes 16-bit greyscale (used by the test tool for marker heightmaps).
    /// Written from the PNG specification (RFC 2083); zlib streams are inflated with System.IO.Compression.
    /// </summary>
    public static class PngCodec
    {
        private static readonly byte[] Signature = { 137, 80, 78, 71, 13, 10, 26, 10 };

        public static GrayImage DecodeFile(string path) => Decode(File.ReadAllBytes(path), path);

        public static GrayImage Decode(byte[] png, string nameForErrors = "png")
        {
            if (png == null || png.Length < 8) throw new PackageException(nameForErrors + ": file is empty or truncated");
            for (int i = 0; i < 8; i++)
                if (png[i] != Signature[i]) throw new PackageException(nameForErrors + ": not a PNG file (bad signature)");

            int width = 0, height = 0, bitDepth = 0, colorType = -1, interlace = 0;
            var idat = new MemoryStream();
            int pos = 8;
            bool seenEnd = false;
            while (pos + 8 <= png.Length && !seenEnd)
            {
                int len = ReadInt32BE(png, pos);
                string type = System.Text.Encoding.ASCII.GetString(png, pos + 4, 4);
                int dataStart = pos + 8;
                if (len < 0 || dataStart + len + 4 > png.Length)
                    throw new PackageException($"{nameForErrors}: chunk '{type}' at byte {pos} is truncated");
                switch (type)
                {
                    case "IHDR":
                        width = ReadInt32BE(png, dataStart);
                        height = ReadInt32BE(png, dataStart + 4);
                        bitDepth = png[dataStart + 8];
                        colorType = png[dataStart + 9];
                        interlace = png[dataStart + 12];
                        break;
                    case "IDAT":
                        idat.Write(png, dataStart, len);
                        break;
                    case "IEND":
                        seenEnd = true;
                        break;
                }
                pos = dataStart + len + 4; // skip CRC
            }

            if (width <= 0 || height <= 0) throw new PackageException(nameForErrors + ": missing or invalid IHDR");
            if (interlace != 0) throw new PackageException(nameForErrors + ": interlaced PNGs are not supported, save without interlacing");
            int channels;
            switch (colorType)
            {
                case 0: channels = 1; break;
                case 2: channels = 3; break;
                case 4: channels = 2; break;
                case 6: channels = 4; break;
                case 3: throw new PackageException(nameForErrors + ": palette PNGs are not supported, use greyscale");
                default: throw new PackageException($"{nameForErrors}: unknown colour type {colorType}");
            }
            if (bitDepth != 8 && bitDepth != 16)
                throw new PackageException($"{nameForErrors}: bit depth {bitDepth} is not supported (use 8 or 16)");

            int bytesPerSample = bitDepth / 8;
            int bpp = channels * bytesPerSample;
            long stride = (long)width * bpp;
            long rawLen = (stride + 1) * height;
            if (rawLen > int.MaxValue) throw new PackageException(nameForErrors + ": image too large");

            byte[] raw = Inflate(idat.ToArray(), (int)rawLen, nameForErrors);

            var img = new GrayImage { Width = width, Height = height, SourceBitDepth = bitDepth, Data = new ushort[width * height] };
            var prev = new byte[stride];
            var cur = new byte[stride];
            int src = 0;
            for (int y = 0; y < height; y++)
            {
                byte filter = raw[src++];
                Buffer.BlockCopy(raw, src, cur, 0, (int)stride);
                src += (int)stride;
                Unfilter(filter, cur, prev, bpp, nameForErrors, y);
                int o = y * width;
                if (bytesPerSample == 2)
                {
                    for (int x = 0; x < width; x++)
                    {
                        int p = x * bpp;
                        img.Data[o + x] = (ushort)((cur[p] << 8) | cur[p + 1]);
                    }
                }
                else
                {
                    for (int x = 0; x < width; x++)
                        img.Data[o + x] = (ushort)(cur[x * bpp] * 257);
                }
                var t = prev; prev = cur; cur = t;
            }
            return img;
        }

        private static byte[] Inflate(byte[] zlib, int expected, string name)
        {
            if (zlib.Length < 2) throw new PackageException(name + ": no image data (IDAT)");
            var output = new byte[expected];
            // Skip the 2-byte zlib header; DeflateStream reads raw deflate. Trailing Adler-32 is ignored.
            using (var ms = new MemoryStream(zlib, 2, zlib.Length - 2))
            using (var ds = new DeflateStream(ms, CompressionMode.Decompress))
            {
                int total = 0;
                while (total < expected)
                {
                    int n = ds.Read(output, total, expected - total);
                    if (n <= 0) break;
                    total += n;
                }
                if (total != expected)
                    throw new PackageException($"{name}: image data is truncated ({total} of {expected} bytes)");
            }
            return output;
        }

        private static void Unfilter(byte filter, byte[] cur, byte[] prev, int bpp, string name, int row)
        {
            int n = cur.Length;
            switch (filter)
            {
                case 0: return;
                case 1:
                    for (int i = bpp; i < n; i++) cur[i] = (byte)(cur[i] + cur[i - bpp]);
                    return;
                case 2:
                    for (int i = 0; i < n; i++) cur[i] = (byte)(cur[i] + prev[i]);
                    return;
                case 3:
                    for (int i = 0; i < n; i++)
                    {
                        int left = i >= bpp ? cur[i - bpp] : 0;
                        cur[i] = (byte)(cur[i] + ((left + prev[i]) >> 1));
                    }
                    return;
                case 4:
                    for (int i = 0; i < n; i++)
                    {
                        int a = i >= bpp ? cur[i - bpp] : 0;
                        int b = prev[i];
                        int c = i >= bpp ? prev[i - bpp] : 0;
                        int p = a + b - c;
                        int pa = Math.Abs(p - a), pb = Math.Abs(p - b), pc = Math.Abs(p - c);
                        int pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
                        cur[i] = (byte)(cur[i] + pred);
                    }
                    return;
                default:
                    throw new PackageException($"{name}: invalid filter type {filter} on row {row}");
            }
        }

        // ------------------------------------------------------------------ encoder (16-bit grey)

        public static byte[] EncodeGray16(int width, int height, ushort[] data)
        {
            if (data.Length != width * height) throw new ArgumentException("data length does not match size");
            int stride = width * 2;
            var raw = new byte[(stride + 1) * height];
            int o = 0;
            for (int y = 0; y < height; y++)
            {
                raw[o++] = 0;
                int r = y * width;
                for (int x = 0; x < width; x++)
                {
                    ushort v = data[r + x];
                    raw[o++] = (byte)(v >> 8);
                    raw[o++] = (byte)v;
                }
            }
            return Encode(width, height, 16, 0, raw);
        }

        public static byte[] EncodeGray8(int width, int height, byte[] data)
        {
            if (data.Length != width * height) throw new ArgumentException("data length does not match size");
            var raw = new byte[(width + 1) * height];
            int o = 0;
            for (int y = 0; y < height; y++)
            {
                raw[o++] = 0;
                Buffer.BlockCopy(data, y * width, raw, o, width);
                o += width;
            }
            return Encode(width, height, 8, 0, raw);
        }

        private static byte[] Encode(int width, int height, byte bitDepth, byte colorType, byte[] raw)
        {
            var outMs = new MemoryStream();
            outMs.Write(Signature, 0, 8);
            var ihdr = new byte[13];
            WriteInt32BE(ihdr, 0, width);
            WriteInt32BE(ihdr, 4, height);
            ihdr[8] = bitDepth; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
            WriteChunk(outMs, "IHDR", ihdr);

            var z = new MemoryStream();
            z.WriteByte(0x78); z.WriteByte(0x01);
            using (var ds = new DeflateStream(z, CompressionLevel.Fastest, leaveOpen: true))
                ds.Write(raw, 0, raw.Length);
            uint adler = Adler32(raw);
            z.WriteByte((byte)(adler >> 24)); z.WriteByte((byte)(adler >> 16)); z.WriteByte((byte)(adler >> 8)); z.WriteByte((byte)adler);
            WriteChunk(outMs, "IDAT", z.ToArray());
            WriteChunk(outMs, "IEND", new byte[0]);
            return outMs.ToArray();
        }

        private static void WriteChunk(Stream s, string type, byte[] data)
        {
            var len = new byte[4];
            WriteInt32BE(len, 0, data.Length);
            s.Write(len, 0, 4);
            var typeBytes = System.Text.Encoding.ASCII.GetBytes(type);
            s.Write(typeBytes, 0, 4);
            s.Write(data, 0, data.Length);
            uint crc = Crc32(typeBytes, data);
            var c = new byte[4];
            WriteInt32BE(c, 0, (int)crc);
            s.Write(c, 0, 4);
        }

        private static uint[] s_CrcTable;

        private static uint Crc32(byte[] type, byte[] data)
        {
            if (s_CrcTable == null)
            {
                var t = new uint[256];
                for (uint n = 0; n < 256; n++)
                {
                    uint c = n;
                    for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
                    t[n] = c;
                }
                s_CrcTable = t;
            }
            uint crc = 0xFFFFFFFFu;
            foreach (byte b in type) crc = s_CrcTable[(crc ^ b) & 0xFF] ^ (crc >> 8);
            foreach (byte b in data) crc = s_CrcTable[(crc ^ b) & 0xFF] ^ (crc >> 8);
            return crc ^ 0xFFFFFFFFu;
        }

        private static uint Adler32(byte[] data)
        {
            uint a = 1, b = 0;
            foreach (byte d in data)
            {
                a = (a + d) % 65521;
                b = (b + a) % 65521;
            }
            return (b << 16) | a;
        }

        private static int ReadInt32BE(byte[] b, int o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];

        private static void WriteInt32BE(byte[] b, int o, int v)
        {
            b[o] = (byte)(v >> 24); b[o + 1] = (byte)(v >> 16); b[o + 2] = (byte)(v >> 8); b[o + 3] = (byte)v;
        }
    }
}
