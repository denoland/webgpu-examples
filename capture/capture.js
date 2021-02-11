import { copyToBuffer, createCapture, createPng } from "../utils.js";

const dimensions = {
  height: 200,
  width: 100,
};

const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice();

const { texture, outputBuffer } = createCapture(device, dimensions);

const encoder = device.createCommandEncoder();
encoder.beginRenderPass({
  colorAttachments: [
    {
      view: texture.createView(),
      storeOp: "store",
      loadValue: [1, 0, 0, 1],
    },
  ],
}).endPass();

copyToBuffer(encoder, texture, outputBuffer, dimensions);

device.queue.submit([encoder.finish()]);

await createPng("./capture.png", outputBuffer, dimensions);
