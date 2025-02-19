import $ from "dax";

for await (const entry of $.path(".").readDir()) {
  if (entry.isDirectory && !entry.name.startsWith(".")) {
    await $`deno run --allow-read=. --allow-write=. --allow-import=deno.land,crux.land,jsr.io mod.ts`
      .cwd(
        entry.path,
      );
  }
}
