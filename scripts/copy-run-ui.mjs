import { cpSync, existsSync } from "node:fs";
cpSync("./ui/run", "./out", { recursive: true });
if (existsSync("./ui/gpu")) cpSync("./ui/gpu", "./out/gpu", { recursive: true });
