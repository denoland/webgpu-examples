import $ from "dax";

const cwd = $.path(".");
for await (const entry of cwd.readDir()) {
  if (entry.isDirectory) {
    await $`deno run --allow-read=. --allow-write=. --unstable mod.ts`.cwd(
      entry.path,
    );
  }
}
