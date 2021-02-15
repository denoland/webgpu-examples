import { gmath } from "../deps.ts";
import {
  copyToBuffer,
  createBufferInit,
  createCapture,
  createImage,
  Dimensions,
  OPENGL_TO_WGPU_MATRIX,
} from "../utils.ts";

function createVertices(): Float32Array {
  // deno-fmt-ignore
  return new Float32Array([
    100.0, 0.0, 0.0, 1.0,
    100.0, 1000.0, 0.0, 1.0,
    -100.0, 0.0, 0.0, 1.0,
    -100.0, 1000.0, 0.0, 1.0,
  ]);
}

function createTexels(size: number, cx: number, cy: number): Uint8Array {
  const texels = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    let x = 4 * (i % size) / (size - 1) - 2;
    let y = 2 * Math.floor(i / size) / (size - 1) - 1;
    let count = 0;
    while (count < 0xFF && x * x + y * y < 4) {
      const oldX = x;
      x = x * x - y * y + cx;
      y = 2.0 * oldX * y + cy;
      count += 1;
    }
    texels.set(
      [
        0xFF - ((count * 2) & ~(~0 << 8)),
        0xFF - ((count * 5) & ~(~0 << 8)),
        0xFF - ((count * 13) & ~(~0 << 8)),
        255,
      ],
      i * 4,
    );
  }
  return texels;
}

function generateMatrix(aspectRatio: number): Float32Array {
  const mxProjection = new gmath.PerspectiveFov(
    new gmath.Deg(45),
    aspectRatio,
    1,
    1000,
  ).toPerspective().toMatrix4();
  const mxView = gmath.Matrix4.lookAtRh(
    new gmath.Vector3(0, 0, 10),
    new gmath.Vector3(0, 50, 0),
    gmath.Vector3.forward,
  );
  return OPENGL_TO_WGPU_MATRIX.mul(mxProjection.mul(mxView)).toFloat32Array();
}

async function generateMipmaps(
  encoder: GPUCommandEncoder,
  device: GPUDevice,
  texture: GPUTexture,
  mipCount: number,
) {
  const shader = device.createShaderModule({
    code: await Deno.readTextFile("blit.wgsl"),
  });
  const pipeline = device.createRenderPipeline({
    label: "blit",
    vertex: {
      module: shader,
      entryPoint: "vs_main",
    },
    fragment: {
      module: shader,
      entryPoint: "fs_main",
      targets: [{
        format: "rgba8unorm-srgb",
      }],
    },
    primitive: {
      topology: "triangle-strip",
    },
  });
  const bindGroupLayout = pipeline.getBindGroupLayout(0);
  const sampler = device.createSampler({
    label: "mip",
    magFilter: "linear",
  });
  const views = [];
  for (let i = 0; i < mipCount; i++) {
    views.push(texture.createView({
      label: "mip",
      baseMipLevel: i,
      mipLevelCount: 1,
    }));
  }

  for (let i = 1; i < mipCount; i++) {
    const bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: views[i - 1],
        },
        {
          binding: 1,
          resource: sampler,
        },
      ],
    });

    const renderPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: views[i],
          storeOp: "store",
          loadValue: [1, 1, 1, 1],
        },
      ],
    });

    renderPass.setPipeline(pipeline);
    renderPass.setBindGroup(0, bindGroup);
    renderPass.draw(4, 1);
    renderPass.endPass();
  }
}

async function render(
  device: GPUDevice,
  drawPipeline: GPURenderPipeline,
  bindGroup: GPUBindGroup,
  vertexBuffer: GPUBuffer,
) {
  const { texture, outputBuffer } = createCapture(device, dimensions);

  const encoder = device.createCommandEncoder();
  const renderPass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: texture.createView(),
        storeOp: "store",
        loadValue: [0.1, 0.2, 0.3, 1],
      },
    ],
  });
  renderPass.setPipeline(drawPipeline);
  renderPass.setBindGroup(0, bindGroup);
  renderPass.setVertexBuffer(0, vertexBuffer);
  renderPass.draw(4, 1);
  renderPass.endPass();

  copyToBuffer(encoder, texture, outputBuffer, dimensions);

  device.queue.submit([encoder.finish()]);

  await createImage(outputBuffer, dimensions);
}

const dimensions: Dimensions = {
  width: 1600,
  height: 1200,
};
const mipLevelCount = 9;

const adapter = await navigator.gpu.requestAdapter();
const device = await adapter?.requestDevice();

if (!device) {
  console.error("no suitable adapter found");
  Deno.exit(0);
}

const initEncoder = device.createCommandEncoder();

const vertexSize = 4 * 4;
const vertexData = createVertices();
const vertexBuffer = createBufferInit(device, {
  label: "Vertex Buffer",
  usage: 0x20,
  contents: vertexData.buffer,
});

const size = 1 << mipLevelCount;
const texels = createTexels(size, -0.8, 0.156);
const textureExtent = {
  width: size,
  height: size,
};
const texture = device.createTexture({
  size: textureExtent,
  mipLevelCount: mipLevelCount,
  format: "rgba8unorm-srgb",
  usage: 4 | 0x10 | 2,
});
const textureView = texture.createView();

const tempBuffer = createBufferInit(device, {
  label: "Temporary Buffer",
  usage: 4,
  contents: texels.buffer,
});
initEncoder.copyBufferToTexture(
  {
    buffer: tempBuffer,
    bytesPerRow: 4 * size,
  },
  {
    texture: texture,
  },
  textureExtent,
);

const sampler = device.createSampler({
  addressModeU: "repeat",
  addressModeV: "repeat",
  addressModeW: "repeat",
  magFilter: "linear",
  minFilter: "linear",
  mipmapFilter: "linear",
});

const uniformBuffer = createBufferInit(device, {
  label: "Uniform Buffer",
  usage: 0x40 | 8,
  contents: generateMatrix(dimensions.width / dimensions.height).buffer,
});

const shader = device.createShaderModule({
  code: await Deno.readTextFile("./draw.wgsl"),
});

const drawPipeline = device.createRenderPipeline({
  label: "draw",
  vertex: {
    module: shader,
    entryPoint: "vs_main",
    buffers: [
      {
        arrayStride: vertexSize,
        attributes: [
          {
            format: "float4",
            offset: 0,
            shaderLocation: 0,
          },
        ],
      },
    ],
  },
  fragment: {
    module: shader,
    entryPoint: "fs_main",
    targets: [
      {
        format: "rgba8unorm-srgb",
      },
    ],
  },
  primitive: {
    topology: "triangle-strip",
    cullMode: "back",
  },
});

const bindGroupLayout = drawPipeline.getBindGroupLayout(0);
const bindGroup = device.createBindGroup({
  layout: bindGroupLayout,
  entries: [
    {
      binding: 0,
      resource: {
        buffer: uniformBuffer,
      },
    },
    {
      binding: 1,
      resource: textureView,
    },
    {
      binding: 2,
      resource: sampler,
    },
  ],
});

await generateMipmaps(initEncoder, device, texture, mipLevelCount);

device.queue.submit([initEncoder.finish()]);

await render(device, drawPipeline, bindGroup, vertexBuffer);
