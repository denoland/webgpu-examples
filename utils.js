import { printImageString } from "https://x.nest.land/terminal_images@2.1.2/mod.ts";
import pngjs from "https://jspm.dev/pngjs";

function getRowPadding(width) {
  // It is a webgpu requirement that BufferCopyView.layout.bytes_per_row % COPY_BYTES_PER_ROW_ALIGNMENT(256) == 0
  // So we calculate padded_bytes_per_row by rounding unpadded_bytes_per_row
  // up to the next multiple of COPY_BYTES_PER_ROW_ALIGNMENT.
  // https://en.wikipedia.org/wiki/Data_structure_alignment#Computing_padding
  const bytesPerPixel = 4;
  const unpaddedBytesPerRow = width * bytesPerPixel;
  const align = 256;
  const paddedBytesPerRowPadding = (align - unpaddedBytesPerRow % align) %
    align;
  const paddedBytesPerRow = unpaddedBytesPerRow + paddedBytesPerRowPadding;

  return {
    unpadded: unpaddedBytesPerRow,
    padded: paddedBytesPerRow,
  };
}

export function createCapture(device, dimensions) {
  const { padded } = getRowPadding(dimensions.width);
  const outputBuffer = device.createBuffer({
    size: padded * dimensions.height,
    usage: 1 | 8,
  });
  const texture = device.createTexture({
    size: dimensions,
    format: "rgba8unorm-srgb",
    usage: 0x10 | 1,
  });

  return { outputBuffer, texture };
}

export function copyToBuffer(encoder, texture, outputBuffer, dimensions) {
  const { padded } = getRowPadding(dimensions.width);

  encoder.copyTextureToBuffer(
    {
      texture,
    },
    {
      buffer: outputBuffer,
      bytesPerRow: padded,
      rowsPerImage: 0,
    },
    dimensions,
  );
}

export async function createPng(path, buffer, dimensions) {
  await buffer.mapAsync(1);
  const inputBuffer = new Uint8Array(buffer.getMappedRange());
  const { padded, unpadded } = getRowPadding(dimensions.width);
  const outputBuffer = new Uint8Array(unpadded * dimensions.height);
  //const encoder = new TextEncoder();

  for (let i = 0; i < dimensions.height; i++) {
    const slice = inputBuffer
      .slice(i * padded, (i + 1) * padded)
      .slice(0, unpadded);
    /*for (const byte of slice) {
      Deno.stdout.writeSync(encoder.encode(byte + ", "));
    }*/

    outputBuffer.set(slice, i * unpadded);
  }

  if (path) {
    const png = new pngjs.PNG({
      ...dimensions,
      bitDepth: 8,
      colorType: 6,
      inputColorType: 6,
      inputHasAlpha: true,
    });
    png.data = outputBuffer;
    const x = pngjs.PNG.sync.write(png);
    await Deno.writeFile(path, x);
  } else {
    printImageString({
      rawPixels: {
        data: outputBuffer,
        ...dimensions,
      },
      color: true,
    });
  }

  buffer.unmap();
}

export function createBufferInit(device, descriptor) {
  const contents = new Uint8Array(descriptor.contents);

  const unpaddedSize = contents.byteLength;
  const padding = 4 - unpaddedSize % 4;
  const paddedSize = padding + unpaddedSize;

  const buffer = device.createBuffer({
    label: descriptor.label,
    usage: descriptor.usage,
    mappedAtCreation: true,
    size: paddedSize,
  });
  const data = new Uint8Array(buffer.getMappedRange());
  data.set(contents);
  buffer.unmap();
  return buffer;
}
