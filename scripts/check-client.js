const fs = require("fs");
const path = require("path");

const htmlPath = path.join(__dirname, "..", "public", "index.html");
const html = fs.readFileSync(htmlPath, "utf8");
const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);

if (!html.includes('/socket.io/socket.io.js')) {
  throw new Error("The app page must load the same-origin Socket.IO client script.");
}

for (const script of inlineScripts) {
  new Function(script);
}

console.log(`Client check passed: parsed ${inlineScripts.length} inline script(s).`);
