import {
  copyToBuffer,
  createBufferInit,
  createCapture,
  createPng,
} from "../utils.js";

function createBundle(
  device,
  format,
  shader,
  pipelineLayout,
  sampleCount,
  vertexBuffer,
  vertexCount,
) {
  const renderPipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: {
      module: shader,
      entryPoint: "vs_main",
      buffers: [
        {
          arrayStride: 24,
          attributes: [
            {
              format: "float2",
              offset: 0,
              shaderLocation: 0,
            },
            {
              format: "float4",
              offset: 8,
              shaderLocation: 1,
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
          format,
        },
      ],
    },
    primitive: {
      topology: "line-list",
    },
    multisample: {
      count: sampleCount,
    },
  });

  const encoder = device.createRenderBundleEncoder({
    colorFormats: [
      format,
    ],
    sampleCount,
  });
  encoder.setPipeline(renderPipeline);
  encoder.setVertexBuffer(0, vertexBuffer);
  encoder.draw(vertexCount, 1);
  return encoder.finish();
}

async function init(device, dimensions, sampleCount) {
  const format = "rgba8unorm-srgb";

  const shader = device.createShaderModule({
    code: await Deno.readTextFile("./shader.wgsl"),
  });

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [],
  });

  const multisampledBuffer = device.createTexture({
    size: dimensions,
    sampleCount,
    format,
    usage: 0x10,
  }).createView();

  const vertexCount = 50;
  const vertexSize = 6;
  const vertexData = new Float32Array((vertexCount * 2) * vertexSize);
  for (let i = 0; i < vertexData.byteLength; i += (vertexSize * 2)) {
    const percent = i / vertexCount;
    const sin = Math.sin(percent * 2 * Math.PI);
    const cos = Math.cos(percent * 2 * Math.PI);

    vertexData[i] = 0; // x
    vertexData[i + 1] = 0; // y
    vertexData[i + 2] = 1; // r
    vertexData[i + 3] = -sin; // g
    vertexData[i + 4] = cos; // b
    vertexData[i + 5] = 1; // a

    vertexData[i + 6] = cos; // x
    vertexData[i + 7] = sin; // y
    vertexData[i + 8] = sin; // r
    vertexData[i + 9] = -cos; // g
    vertexData[i + 10] = 1; // b
    vertexData[i + 11] = 1; // a
  }

  /*
  const unpaddedSize = vertexData.byteLength;
  const padding = 4 - unpaddedSize % 4;
  const paddedSize = padding + unpaddedSize;

  const vertexBuffer = device.createBuffer({
    label: "Vertex Buffer",
    usage: 0x0020,
    mappedAtCreation: true,
    size: paddedSize,
  });
  const data = new Float32Array(vertexBuffer.getMappedRange());
  data.set(vertexData);
  vertexBuffer.unmap();
  */
  const vertexBuffer = createBufferInit(device, {
    label: "Vertex Buffer",
    usage: 0x0020,
    contents: vertexData.buffer,
  });

  const bundle = createBundle(
    device,
    format,
    shader,
    pipelineLayout,
    sampleCount,
    vertexBuffer,
    vertexCount * 2,
  );

  await render(device, dimensions, multisampledBuffer, bundle);
}

async function render(device, dimensions, multisampledBuffer, bundle) {
  const { texture, outputBuffer } = createCapture(device, dimensions);

  const encoder = device.createCommandEncoder();
  const renderPass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: multisampledBuffer,
        resolveTarget: texture.createView(),
        storeOp: "store",
        loadValue: [0, 0, 0, 1],
      },
    ],
  });
  renderPass.executeBundles([bundle]);
  renderPass.endPass();

  copyToBuffer(encoder, texture, outputBuffer, dimensions);

  device.queue.submit([encoder.finish()]);

  await createPng("./msaa_line.png", outputBuffer, dimensions);
}

const dimensions = {
  height: 1200,
  width: 1600,
};

const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice();

await init(device, dimensions, 4);
