import { Framework } from "../framework.ts";
import { Dds, gmath, obj } from "../deps.ts";
import {
  createBufferInit,
  Dimensions,
  OPENGL_TO_WGPU_MATRIX,
} from "../utils.ts";

interface Entity {
  vertexCount: number;
  vertexBuffer: GPUBuffer;
}

interface Camera {
  dimensions: Dimensions;
  angleXZ: number;
  angleY: number;
  dist: number;
}

const DEPTH_FORMAT = "depth24plus";
const MODEL_CENTER_Y = 2;
const IMAGE_SIZE = 128;

function cameraToUniformData(camera: Camera): Float32Array {
  const mxProjection = new gmath.PerspectiveFov(
    new gmath.Deg(45),
    camera.dimensions.width / camera.dimensions.height,
    1,
    50,
  ).toPerspective().toMatrix4();
  const camPos = new gmath.Vector3(
    Math.cos(camera.angleXZ) * Math.sin(camera.angleY) * camera.dist,
    Math.sin(camera.angleXZ) * camera.dist + MODEL_CENTER_Y,
    Math.cos(camera.angleXZ) * Math.cos(camera.angleY) * camera.dist,
  );
  const mxView = gmath.Matrix4.lookAtRh(
    camPos,
    new gmath.Vector3(0, MODEL_CENTER_Y, 0),
    gmath.Vector3.up(),
  );
  const proj = OPENGL_TO_WGPU_MATRIX.mul(mxProjection);
  const projInvert = proj.invert();
  const view = OPENGL_TO_WGPU_MATRIX.mul(mxView);
  return new Float32Array([
    ...proj.toFloat32Array(),
    ...projInvert!.toFloat32Array(),
    ...view.toFloat32Array(),
    ...camPos.toFloat32Array(),
    1,
  ]);
}

class Skybox extends Framework {
  entities: Entity[] = [];
  depthView!: GPUTextureView;
  camera!: Camera;
  skyPipeline!: GPURenderPipeline;
  entityPipeline!: GPURenderPipeline;
  bindGroup!: GPUBindGroup;
  uniformBuffer!: GPUBuffer;

  async init() {
    const data = obj.Obj.parse(
      Deno.readTextFileSync(
        new URL("./models/teslacyberv3.0.obj", import.meta.url),
      ),
      {
        strict: true,
      },
    );
    let vertices = [];
    for (const object of data.objects) {
      for (const group of object.groups) {
        vertices = [];
        for (const poly of group.polys) {
          for (let i = 2; i < poly.length; i++) {
            for (const index of [0, i - 1, i]) {
              const [pos, _, nor] = poly[index];
              vertices.push(
                ...data.position[pos],
                ...data.normal[nor!],
              );
            }
          }
        }
        const vertexBuffer = createBufferInit(this.device, {
          label: "Vertex",
          contents: new Float32Array(vertices).buffer,
          usage: GPUBufferUsage.VERTEX,
        });
        this.entities.push({
          vertexCount: vertices.length / 6,
          vertexBuffer,
        });
      }
    }

    const bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {},
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {
            viewDimension: "cube",
          },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: {},
        },
      ],
    });

    const shader = this.device.createShaderModule({
      code: Deno.readTextFileSync(new URL("./shader.wgsl", import.meta.url)),
    });

    this.camera = {
      dimensions: this.dimensions,
      angleXZ: 0.2,
      angleY: 0.2,
      dist: 30.0,
    };
    this.uniformBuffer = createBufferInit(this.device, {
      label: "Buffer",
      contents: cameraToUniformData(this.camera).buffer,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    });
    this.skyPipeline = this.device.createRenderPipeline({
      label: "Sky",
      layout: pipelineLayout,
      vertex: {
        module: shader,
        entryPoint: "vs_sky",
      },
      fragment: {
        module: shader,
        entryPoint: "fs_sky",
        targets: [
          {
            format: "rgba8unorm-srgb",
          },
        ],
      },
      primitive: {
        frontFace: "cw",
      },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthCompare: "less-equal",
      },
    });

    this.entityPipeline = this.device.createRenderPipeline({
      label: "Entity",
      layout: pipelineLayout,
      vertex: {
        module: shader,
        entryPoint: "vs_entity",
        buffers: [
          {
            arrayStride: (4 * 3) + (4 * 3),
            attributes: [
              {
                format: "float32x3",
                offset: 0,
                shaderLocation: 0,
              },
              {
                format: "float32x3",
                offset: 12,
                shaderLocation: 1,
              },
            ],
          },
        ],
      },
      fragment: {
        module: shader,
        entryPoint: "fs_entity",
        targets: [
          {
            format: "rgba8unorm-srgb",
          },
        ],
      },
      primitive: {
        frontFace: "cw",
      },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
    });

    const sampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      maxAnisotropy: 0,
    });

    let skyboxFormat!: GPUTextureFormat;
    if (this.device.features.includes("texture-compression-bc")) {
      skyboxFormat = "bc1-rgba-unorm-srgb";
    } else {
      skyboxFormat = "bgra8unorm-srgb";
    }

    const size: GPUExtent3D = {
      width: IMAGE_SIZE,
      height: IMAGE_SIZE,
      depthOrArrayLayers: 6,
    };

    const maxMips = 32 - Math.clz32(Math.max(size.width!, size.height!, 1));

    const image = Dds.read(
      Deno.readFileSync(
        new URL(
          skyboxFormat === "bc1-rgba-unorm-srgb"
            ? "./images/bc1.dds"
            : "./images/bgra.dds",
          import.meta.url,
        ),
      ),
    ).data;

    const texture = this.device.createTexture({
      size,
      mipLevelCount: maxMips,
      format: skyboxFormat,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    const blockDimensions = skyboxFormat === "bc1-rgba-unorm-srgb"
      ? [4, 4]
      : [1, 1];
    const blockSize = skyboxFormat === "bc1-rgba-unorm-srgb" ? 8 : 4;

    let binaryOffset = 0;
    for (let i = 0; i < size.depthOrArrayLayers!; i++) {
      for (let j = 0; j < maxMips; j++) {
        const mipSize = {
          width: Math.max(1, size.width! >> j),
          height: Math.max(1, size.height! >> j),
          depth: Math.max(1, 1 >> j),
        };

        const physicalWidth = Math.floor(
          (mipSize.width + blockDimensions[0] - 1) / blockDimensions[0],
        ) * blockDimensions[0];
        const physicalHeight = Math.floor(
          (mipSize.height + blockDimensions[1] - 1) / blockDimensions[1],
        ) * blockDimensions[1];

        const widthBlocks = Math.floor(physicalWidth / blockDimensions[0]);
        const heightBlocks = Math.floor(physicalHeight / blockDimensions[1]);
        const bytesPerRow = widthBlocks * blockSize;
        const dataSize = bytesPerRow * heightBlocks;
        const endOffset = binaryOffset + dataSize;

        this.device.queue.writeTexture(
          {
            texture,
            mipLevel: j,
            origin: {
              x: 0,
              y: 0,
              z: i,
            },
          },
          image.slice(binaryOffset, endOffset),
          {
            bytesPerRow,
            rowsPerImage: 0,
          },
          {
            width: physicalWidth,
            height: physicalHeight,
            depthOrArrayLayers: 1,
          },
        );

        binaryOffset = endOffset;
      }
    }

    const textureView = texture.createView({
      dimension: "cube",
    });
    this.bindGroup = this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.uniformBuffer,
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

    const depthTexture = this.device.createTexture({
      size: this.dimensions,
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthView = depthTexture.createView();
  }

  render(encoder: GPUCommandEncoder, view: GPUTextureView) {
    const renderPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: view,
          storeOp: "store",
          loadValue: [0.1, 0.2, 0.3, 1],
        },
      ],
      depthStencilAttachment: {
        view: this.depthView,
        depthLoadValue: 1,
        depthStoreOp: "discard",
        stencilLoadValue: "load",
        stencilStoreOp: "store",
        stencilReadOnly: true,
      },
    });

    renderPass.setBindGroup(0, this.bindGroup);
    renderPass.setPipeline(this.entityPipeline);
    for (const entity of this.entities) {
      renderPass.setVertexBuffer(0, entity.vertexBuffer);
      renderPass.draw(entity.vertexCount);
    }
    renderPass.setPipeline(this.skyPipeline);
    renderPass.draw(3);
    renderPass.endPass();
  }
}

const skybox = new Skybox(
  {
    width: 1600,
    height: 1200,
  },
  await Skybox.getDevice([
    "texture-compression-bc",
  ]),
);
await skybox.renderPng();
