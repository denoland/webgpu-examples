import {
  copyToBuffer,
  createCapture,
  createPng,
  Dimensions,
} from "../utils.ts";

const dimensions: Dimensions = {
  width: 200,
  height: 200,
};

const adapter = await navigator.gpu.requestAdapter();
const device = await adapter?.requestDevice();

if (!device) {
  console.error("no suitable adapter found");
  Deno.exit(0);
}

const shaderModule = device.createShaderModule({
  code: await Deno.readTextFile("./shader.wgsl"),
});

const pipelineLayout = device.createPipelineLayout({
  bindGroupLayouts: [],
});

const renderPipeline = device.createRenderPipeline({
  layout: pipelineLayout,
  vertex: {
    module: shaderModule,
    entryPoint: "vs_main",
  },
  fragment: {
    module: shaderModule,
    entryPoint: "fs_main",
    targets: [
      {
        format: "rgba8unorm-srgb",
      },
    ],
  },
});

const { texture, outputBuffer } = createCapture(device, dimensions);

const encoder = device.createCommandEncoder();
const renderPass = encoder.beginRenderPass({
  colorAttachments: [
    {
      view: texture.createView(),
      storeOp: "store",
      loadValue: [0, 1, 0, 1],
    },
  ],
});
renderPass.setPipeline(renderPipeline);
renderPass.draw(3, 1);
renderPass.endPass();

copyToBuffer(encoder, texture, outputBuffer, dimensions);

device.queue.submit([encoder.finish()]);

await createPng(outputBuffer, dimensions);
