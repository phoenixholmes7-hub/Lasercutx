// Thin layer over the desktop (Electron) and plain-browser environments.
const desktop = typeof window !== 'undefined' ? window.lcx : null;

export const isDesktop = !!desktop;

const toBytes = (data) => (typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));

// Saves one file. Returns the saved path/name, or null if cancelled.
export async function saveFile(name, data, filter) {
  if (desktop) return desktop.saveFile({ name, data: toBytes(data), filter });
  download(name, data, filter);
  return name;
}

// Saves several files at once (e.g. front + back). In the desktop app the user
// picks a folder once; in a browser each file is downloaded.
export async function saveFiles(files, filter) {
  if (desktop) {
    return desktop.saveFiles({ files: files.map((f) => ({ name: f.name, data: toBytes(f.data) })), filter });
  }
  for (const f of files) download(f.name, f.data, filter);
  return files.map((f) => f.name);
}

function download(name, data, filter) {
  const blob = new Blob([data], { type: filter?.mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// Opens a file picker. Resolves to a File or null.
export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.getElementById('fileInput');
    input.value = '';
    input.accept = accept || '';
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

export const readAsText = (file) => file.text();
export const readAsArrayBuffer = (file) => file.arrayBuffer();
export function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
