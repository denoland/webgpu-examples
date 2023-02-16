import { gmath, png } from "./deps.ts";

export interface Dimensions {
  width: number;
  height: number;
}

interface Padding {
  unpadded: number;
  padded: number;
}

function getRowPadding(width: number): Padding {
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

interface CreateCapture {
  texture: GPUTexture;
  outputBuffer: GPUBuffer;
}

export function createCapture(
  device: GPUDevice,
  dimensions: Dimensions,
): CreateCapture {
  const { padded } = getRowPadding(dimensions.width);
  const outputBuffer = device.createBuffer({
    label: "Capture",
    size: padded * dimensions.height,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const texture = device.createTexture({
    label: "Capture",
    size: dimensions,
    format: "rgba8unorm-srgb",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });

  return { outputBuffer, texture };
}

export function copyToBuffer(
  encoder: GPUCommandEncoder,
  texture: GPUTexture,
  outputBuffer: GPUBuffer,
  dimensions: Dimensions,
): void {
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

export async function createPng(
  buffer: GPUBuffer,
  dimensions: Dimensions,
): Promise<void> {
  await buffer.mapAsync(1);
  const inputBuffer = new Uint8Array(buffer.getMappedRange());
  const { padded, unpadded } = getRowPadding(dimensions.width);
  const outputBuffer = new Uint8Array(unpadded * dimensions.height);

  for (let i = 0; i < dimensions.height; i++) {
    const slice = inputBuffer
      .slice(i * padded, (i + 1) * padded)
      .slice(0, unpadded);

    outputBuffer.set(slice, i * unpadded);
  }

  const image = png.encode(
    outputBuffer,
    dimensions.width,
    dimensions.height,
    {
      stripAlpha: true,
      color: 2,
    },
  );
  Deno.writeFileSync("./output.png", image);

  buffer.unmap();
}

interface BufferInit {
  label?: string;
  usage: number;
  contents: ArrayBuffer;
}

export function createBufferInit(
  device: GPUDevice,
  descriptor: BufferInit,
): GPUBuffer {
  const contents = new Uint8Array(descriptor.contents);

  const alignMask = 4 - 1;
  const paddedSize = Math.max(
    (contents.byteLength + alignMask) & ~alignMask,
    4,
  );

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

function textureDimensionArrayLayerCount(
  texture: GPUTextureDescriptor,
): number {
  switch (texture.dimension) {
    case "1d":
    case "3d":
      return 1;
    case undefined:
    case "2d":
      if (Array.isArray(texture.size)) {
        return texture.size[2] ?? 1;
      } else {
        return texture.size.depthOrArrayLayers ?? 1;
      }
  }
}

interface TextureFormatInfo {
  requiredFeature?: GPUFeatureName;
  sampleType: GPUTextureSampleType;
  usage: number;
  blockDimensions: [number, number];
  blockSize: number;
  components: number;
}

const basic = GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST |
  GPUTextureUsage.TEXTURE_BINDING;
const attachment = basic | GPUTextureUsage.RENDER_ATTACHMENT;
const storage = basic | GPUTextureUsage.STORAGE_BINDING;
const allFlags = GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST |
  GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING |
  GPUTextureUsage.RENDER_ATTACHMENT;

function describeTextureFormat(format: GPUTextureFormat): TextureFormatInfo {
  let info: [
    requiredFeatures: GPUFeatureName | undefined,
    sampleType: GPUTextureSampleType,
    usage: number,
    blockDimensions: [number, number],
    blockSize: number,
    components: number,
  ] | [];

  switch (format) {
    case "r8unorm":
      info = [undefined, "float", attachment, [1, 1], 1, 1];
      break;
    case "r8snorm":
      info = [undefined, "float", basic, [1, 1], 1, 1];
      break;
    case "r8uint":
      info = [undefined, "uint", attachment, [1, 1], 1, 1];
      break;
    case "r8sint":
      info = [undefined, "sint", attachment, [1, 1], 1, 1];
      break;

    case "r16uint":
      info = [undefined, "uint", attachment, [1, 1], 2, 1];
      break;
    case "r16sint":
      info = [undefined, "sint", attachment, [1, 1], 2, 1];
      break;
    case "r16float":
      info = [undefined, "float", attachment, [1, 1], 2, 1];
      break;
    case "rg8unorm":
      info = [undefined, "float", attachment, [1, 1], 2, 2];
      break;
    case "rg8snorm":
      info = [undefined, "float", attachment, [1, 1], 2, 2];
      break;
    case "rg8uint":
      info = [undefined, "uint", attachment, [1, 1], 2, 2];
      break;
    case "rg8sint":
      info = [undefined, "sint", basic, [1, 1], 2, 2];
      break;

    case "r32uint":
      info = [undefined, "uint", allFlags, [1, 1], 4, 1];
      break;
    case "r32sint":
      info = [undefined, "sint", allFlags, [1, 1], 4, 1];
      break;
    case "r32float":
      info = [undefined, "unfilterable-float", allFlags, [1, 1], 4, 1];
      break;
    case "rg16uint":
      info = [undefined, "uint", attachment, [1, 1], 4, 2];
      break;
    case "rg16sint":
      info = [undefined, "sint", attachment, [1, 1], 4, 2];
      break;
    case "rg16float":
      info = [undefined, "float", attachment, [1, 1], 4, 2];
      break;
    case "rgba8unorm":
      info = [undefined, "float", allFlags, [1, 1], 4, 4];
      break;
    case "rgba8unorm-srgb":
      info = [undefined, "float", attachment, [1, 1], 4, 4];
      break;
    case "rgba8snorm":
      info = [undefined, "float", storage, [1, 1], 4, 4];
      break;
    case "rgba8uint":
      info = [undefined, "uint", allFlags, [1, 1], 4, 4];
      break;
    case "rgba8sint":
      info = [undefined, "sint", allFlags, [1, 1], 4, 4];
      break;
    case "bgra8unorm":
      info = [undefined, "float", attachment, [1, 1], 4, 4];
      break;
    case "bgra8unorm-srgb":
      info = [undefined, "float", attachment, [1, 1], 4, 4];
      break;

    case "rgb9e5ufloat":
      info = [undefined, "float", basic, [1, 1], 4, 3];
      break;

    case "rgb10a2unorm":
      info = [undefined, "float", attachment, [1, 1], 4, 4];
      break;
    case "rg11b10ufloat":
      info = [undefined, "float", basic, [1, 1], 4, 3];
      break;

    case "rg32uint":
      info = [undefined, "uint", allFlags, [1, 1], 8, 2];
      break;
    case "rg32sint":
      info = [undefined, "sint", allFlags, [1, 1], 8, 2];
      break;
    case "rg32float":
      info = [undefined, "unfilterable-float", allFlags, [1, 1], 8, 2];
      break;
    case "rgba16uint":
      info = [undefined, "uint", allFlags, [1, 1], 8, 4];
      break;
    case "rgba16sint":
      info = [undefined, "sint", allFlags, [1, 1], 8, 4];
      break;
    case "rgba16float":
      info = [undefined, "float", allFlags, [1, 1], 8, 4];
      break;

    case "rgba32uint":
      info = [undefined, "uint", allFlags, [1, 1], 16, 4];
      break;
    case "rgba32sint":
      info = [undefined, "sint", allFlags, [1, 1], 16, 4];
      break;
    case "rgba32float":
      info = [undefined, "float", allFlags, [1, 1], 16, 4];
      break;

    case "stencil8": // TODO
      info = [];
      break;
    case "depth16unorm": // TODO
      info = [];
      break;
    case "depth24plus":
      info = [undefined, "depth", attachment, [1, 1], 4, 1];
      break;
    case "depth24plus-stencil8":
      info = [undefined, "depth", attachment, [1, 1], 4, 2];
      break;
    case "depth32float":
      info = [undefined, "depth", attachment, [1, 1], 4, 1];
      break;
    case "depth32float-stencil8":
      info = ["depth32float-stencil8", "depth", attachment, [1, 1], 4, 2];
      break;

    case "bc1-rgba-unorm":
      info = ["texture-compression-bc", "float", basic, [4, 4], 8, 4];
      break;
    case "bc1-rgba-unorm-srgb":
      info = ["texture-compression-bc", "float", basic, [4, 4], 8, 4];
      break;
    case "bc2-rgba-unorm":
      info = ["texture-compression-bc", "float", basic, [4, 4], 16, 4];
      break;
    case "bc2-rgba-unorm-srgb":
      info = ["texture-compression-bc", "float", basic, [4, 4], 16, 4];
      break;
    case "bc3-rgba-unorm":
      info = ["texture-compression-bc", "float", basic, [4, 4], 16, 4];
      break;
    case "bc3-rgba-unorm-srgb":
      info = ["texture-compression-bc", "float", basic, [4, 4], 16, 4];
      break;
    case "bc4-r-unorm":
      info = ["texture-compression-bc", "float", basic, [4, 4], 8, 1];
      break;
    case "bc4-r-snorm":
      info = ["texture-compression-bc", "float", basic, [4, 4], 8, 1];
      break;
    case "bc5-rg-unorm":
      info = ["texture-compression-bc", "float", basic, [4, 4], 16, 2];
      break;
    case "bc5-rg-snorm":
      info = ["texture-compression-bc", "float", basic, [4, 4], 16, 2];
      break;
    case "bc6h-rgb-ufloat":
      info = ["texture-compression-bc", "float", basic, [4, 4], 16, 3];
      break;
    case "bc6h-rgb-float":
      info = ["texture-compression-bc", "float", basic, [4, 4], 16, 3];
      break;
    case "bc7-rgba-unorm":
      info = ["texture-compression-bc", "float", basic, [4, 4], 16, 4];
      break;
    case "bc7-rgba-unorm-srgb":
      info = ["texture-compression-bc", "float", basic, [4, 4], 16, 4];
      break;

    case "etc2-rgb8unorm":
      info = ["texture-compression-etc2", "float", basic, [4, 4], 8, 3];
      break;
    case "etc2-rgb8unorm-srgb":
      info = ["texture-compression-etc2", "float", basic, [4, 4], 8, 3];
      break;
    case "etc2-rgb8a1unorm":
      info = ["texture-compression-etc2", "float", basic, [4, 4], 8, 4];
      break;
    case "etc2-rgb8a1unorm-srgb":
      info = ["texture-compression-etc2", "float", basic, [4, 4], 8, 4];
      break;
    case "etc2-rgba8unorm":
      info = ["texture-compression-etc2", "float", basic, [4, 4], 16, 4];
      break;
    case "etc2-rgba8unorm-srgb":
      info = ["texture-compression-etc2", "float", basic, [4, 4], 16, 4];
      break;
    case "eac-r11unorm":
      info = ["texture-compression-etc2", "float", basic, [4, 4], 8, 1];
      break;
    case "eac-r11snorm":
      info = ["texture-compression-etc2", "float", basic, [4, 4], 8, 1];
      break;
    case "eac-rg11unorm":
      info = ["texture-compression-etc2", "float", basic, [4, 4], 16, 2];
      break;
    case "eac-rg11snorm":
      info = ["texture-compression-etc2", "float", basic, [4, 4], 16, 2];
      break;

    case "astc-4x4-unorm":
      info = ["texture-compression-astc", "float", basic, [4, 4], 16, 4];
      break;
    case "astc-4x4-unorm-srgb":
      info = ["texture-compression-astc", "float", basic, [4, 4], 16, 4];
      break;
    case "astc-5x4-unorm":
      info = ["texture-compression-astc", "float", basic, [5, 4], 16, 4];
      break;
    case "astc-5x4-unorm-srgb":
      info = ["texture-compression-astc", "float", basic, [5, 4], 16, 4];
      break;
    case "astc-5x5-unorm":
      info = ["texture-compression-astc", "float", basic, [5, 5], 16, 4];
      break;
    case "astc-5x5-unorm-srgb":
      info = ["texture-compression-astc", "float", basic, [5, 5], 16, 4];
      break;
    case "astc-6x5-unorm":
      info = ["texture-compression-astc", "float", basic, [6, 5], 16, 4];
      break;
    case "astc-6x5-unorm-srgb":
      info = ["texture-compression-astc", "float", basic, [6, 5], 16, 4];
      break;
    case "astc-6x6-unorm":
      info = ["texture-compression-astc", "float", basic, [6, 6], 16, 4];
      break;
    case "astc-6x6-unorm-srgb":
      info = ["texture-compression-astc", "float", basic, [6, 6], 16, 4];
      break;
    case "astc-8x5-unorm":
      info = ["texture-compression-astc", "float", basic, [8, 5], 16, 4];
      break;
    case "astc-8x5-unorm-srgb":
      info = ["texture-compression-astc", "float", basic, [8, 5], 16, 4];
      break;
    case "astc-8x6-unorm":
      info = ["texture-compression-astc", "float", basic, [8, 6], 16, 4];
      break;
    case "astc-8x6-unorm-srgb":
      info = ["texture-compression-astc", "float", basic, [8, 6], 16, 4];
      break;
    case "astc-8x8-unorm":
      info = ["texture-compression-astc", "float", basic, [8, 8], 16, 4];
      break;
    case "astc-8x8-unorm-srgb":
      info = ["texture-compression-astc", "float", basic, [8, 8], 16, 4];
      break;
    case "astc-10x5-unorm":
      info = ["texture-compression-astc", "float", basic, [10, 5], 16, 4];
      break;
    case "astc-10x5-unorm-srgb":
      info = ["texture-compression-astc", "float", basic, [10, 5], 16, 4];
      break;
    case "astc-10x6-unorm":
      info = ["texture-compression-astc", "float", basic, [10, 6], 16, 4];
      break;
    case "astc-10x6-unorm-srgb":
      info = ["texture-compression-astc", "float", basic, [10, 6], 16, 4];
      break;
    case "astc-10x8-unorm":
      info = ["texture-compression-astc", "float", basic, [10, 8], 16, 4];
      break;
    case "astc-10x8-unorm-srgb":
      info = ["texture-compression-astc", "float", basic, [10, 8], 16, 4];
      break;
    case "astc-10x10-unorm":
      info = ["texture-compression-astc", "float", basic, [10, 10], 16, 4];
      break;
    case "astc-10x10-unorm-srgb":
      info = ["texture-compression-astc", "float", basic, [10, 10], 16, 4];
      break;
    case "astc-12x10-unorm":
      info = ["texture-compression-astc", "float", basic, [12, 10], 16, 4];
      break;
    case "astc-12x10-unorm-srgb":
      info = ["texture-compression-astc", "float", basic, [12, 10], 16, 4];
      break;
    case "astc-12x12-unorm":
      info = ["texture-compression-astc", "float", basic, [12, 12], 16, 4];
      break;
    case "astc-12x12-unorm-srgb":
      info = ["texture-compression-astc", "float", basic, [12, 12], 16, 4];
      break;
  }

  return {
    requiredFeature: info[0],
    sampleType: info[1]!,
    usage: info[2]!,
    blockDimensions: info[3]!,
    blockSize: info[4]!,
    components: info[5]!,
  };
}

function normalizeExtent3D(size: GPUExtent3D): GPUExtent3DDict {
  if (Array.isArray(size)) {
    return {
      width: size[0],
      height: size[1],
      depthOrArrayLayers: size[2],
    };
  } else {
    return size;
  }
}

function extent3DPhysicalSize(
  size: GPUExtent3D,
  format: GPUTextureFormat,
): GPUExtent3DDict {
  const [blockWidth, blockHeight] =
    describeTextureFormat(format).blockDimensions;
  const nSize = normalizeExtent3D(size);

  const width = Math.floor((nSize.width + blockWidth - 1) / blockWidth) *
    blockWidth;
  const height =
    Math.floor(((nSize.height ?? 1) + blockHeight - 1) / blockHeight) *
    blockHeight;

  return {
    width,
    height,
    depthOrArrayLayers: nSize.depthOrArrayLayers,
  };
}

function extent3DMipLevelSize(
  size: GPUExtent3D,
  level: number,
  is3D: boolean,
): GPUExtent3DDict {
  const nSize = normalizeExtent3D(size);
  return {
    height: Math.max(1, nSize.width >> level),
    width: Math.max(1, (nSize.height ?? 1) >> level),
    depthOrArrayLayers: is3D
      ? Math.max(1, (nSize.depthOrArrayLayers ?? 1) >> level)
      : (nSize.depthOrArrayLayers ?? 1),
  };
}

function textureMipLevelSize(
  descriptor: GPUTextureDescriptor,
  level: number,
): GPUExtent3DDict | undefined {
  if (level >= (descriptor.mipLevelCount ?? 1)) {
    return undefined;
  }

  return extent3DMipLevelSize(
    descriptor.size,
    level,
    descriptor.dimension === "3d",
  );
}

export function createTextureWithData(
  device: GPUDevice,
  descriptor: GPUTextureDescriptor,
  data: Uint8Array,
): GPUTexture {
  descriptor.usage |= GPUTextureUsage.COPY_DST;
  const texture = device.createTexture(descriptor);
  const layerIterations = textureDimensionArrayLayerCount(descriptor);
  const formatInfo = describeTextureFormat(descriptor.format);

  let binaryOffset = 0;
  for (let layer = 0; layer < layerIterations; layer++) {
    for (let mip = 0; mip < (descriptor.mipLevelCount ?? 1); mip++) {
      const mipSize = textureMipLevelSize(descriptor, mip)!;
      if (descriptor.dimension !== "3d") {
        mipSize.depthOrArrayLayers = 1;
      }

      const mipPhysical = extent3DPhysicalSize(mipSize, descriptor.format);
      const widthBlocks = Math.floor(
        mipPhysical.width / formatInfo.blockDimensions[0],
      );
      const heightBlocks = Math.floor(
        mipPhysical.height! / formatInfo.blockDimensions[1],
      );

      const bytesPerRow = widthBlocks * formatInfo.blockSize;
      const dataSize = bytesPerRow * heightBlocks * mipSize.depthOrArrayLayers!;

      const endOffset = binaryOffset + dataSize;

      device.queue.writeTexture(
        {
          texture,
          mipLevel: mip,
          origin: {
            x: 0,
            y: 0,
            z: layer,
          },
        },
        data.subarray(binaryOffset, endOffset),
        {
          bytesPerRow,
          rowsPerImage: heightBlocks,
        },
        mipPhysical,
      );

      binaryOffset = endOffset;
    }
  }

  return texture;
}

// deno-fmt-ignore
export const OPENGL_TO_WGPU_MATRIX = gmath.Matrix4.from(
  1.0, 0.0, 0.0, 0.0,
  0.0, 1.0, 0.0, 0.0,
  0.0, 0.0, 0.5, 0.0,
  0.0, 0.0, 0.5, 1.0,
);
