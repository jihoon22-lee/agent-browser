import {createServer} from 'node:http';

export async function startIframeFixture(){
  const server=createServer((req,res)=>{
    const port=server.address().port;
    const pages={
      '/case':`<title>Iframe mail fixture</title><p>top-only</p><iframe src="/mail"></iframe><iframe src="http://localhost:${port}/mail"></iframe><iframe src="/middle"></iframe>`,
      '/middle':`<iframe src="http://localhost:${port}/mail"></iframe>`,
      '/mail':`<title>Synthetic inbox</title>
        <div onclick="document.querySelector('#body').textContent='inline body'">Inline mail</div>
        <div tabindex="0" onclick="document.querySelector('#body').textContent='keyboard body'">Keyboard mail</div>
        <div style="height:900px"></div>
        <button onclick="document.querySelector('#body').textContent='opened body'">Open body</button>
        <button onclick="if(event.clientX>0&&event.clientY>0)document.querySelector('#body').textContent='coordinate body'">Coordinate guarded</button>
        <button onclick="if(event.isTrusted)document.querySelector('#body').textContent='trusted body'">Trusted guarded</button>
        <label><input type="checkbox">Native checkbox</label>
        <a href="/body" target="_blank">New tab</a><div id="body"></div>
        <script>window.events=[];for(const type of ['pointerdown','mousedown','pointerup','mouseup','click'])document.addEventListener(type,e=>events.push({type:e.type,x:e.clientX,y:e.clientY,buttons:e.buttons,trusted:e.isTrusted}));</script>`,
      '/body':'<title>New mail body</title>Opened new tab',
    };
    res.writeHead(pages[req.url]?200:404,{'Content-Type':'text/html; charset=utf-8'});
    res.end('<!doctype html>'+ (pages[req.url]??'not found'));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {port:server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
}
