// Runs the editor in a normal web browser (no install needed beyond Node):
//   npm run web   → http://localhost:5173
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'src');
const port = Number(process.env.PORT) || 5173;
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) return res.writeHead(403).end();
    if (url.pathname === '/') file = path.join(root, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end('Not found');
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  })
  .listen(port, () => console.log(`LaserCutX running at http://localhost:${port}`));
