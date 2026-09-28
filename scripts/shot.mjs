import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { findBrowser } from "./lib/browser.mjs";
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const edge = await findBrowser();
const TYPE = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".png":"image/png" };
const server = createServer((req,res)=>{
  let pathname="/"; try{ pathname=new URL(req.url??"/","http://127.0.0.1").pathname }catch{}
  let rel = decodeURIComponent(pathname).replace(/^[/\\]+/,"");
  const pre="plugins/dsh-client-hei-poster/assets/"; if(rel.startsWith(pre)) rel="assets/"+rel.slice(pre.length);
  rel = normalize(rel);
  const file = join(PACKAGE_ROOT, rel===""?"test/preview.html":rel);
  if(!file.startsWith(PACKAGE_ROOT)||!existsSync(file)||!statSync(file).isFile()){res.writeHead(404);res.end();return}
  res.writeHead(200,{"Content-Type":TYPE[extname(file)]??"application/octet-stream","Cache-Control":"no-store"});
  res.end(readFileSync(file));
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const port=server.address().port;
const out = process.argv[2];
const query = process.argv[3] || "";
const args=["--headless=new","--disable-gpu","--no-first-run","--hide-scrollbars","--window-size=1280,800","--virtual-time-budget=6000","--screenshot="+out,"http://127.0.0.1:"+port+"/test/preview.html"+query];
const res = await new Promise((resolve)=>{ const c=spawn(edge,args,{stdio:["ignore","pipe","pipe"]}); let e=""; c.stderr.on("data",d=>{e+=d}); c.on("close",code=>resolve({code,e})); setTimeout(()=>{try{c.kill()}catch{}},60000); });
server.close();
console.log("edge exit="+res.code+" -> "+out+" exists="+existsSync(out));
if(res.code!==0) console.log(res.e.slice(-400));