// Files the person picked or dropped, where the wasm build's Foundation can
// read them: an in-memory, read-only directory preopened as /tmp/uui-import
// behind the WASI file calls, so `Data(contentsOf: url)` works on the web as
// it does on Android (the app's cache directory) and Apple.

const ROOT = "/tmp/uui-import";
const PREOPEN_FD = 3;
const SUCCESS = 0, EBADF = 8, ENOENT = 44, EROFS = 69, EINVAL = 28;
const FILETYPE_DIRECTORY = 3, FILETYPE_REGULAR = 4;

const files = new Map(); // path under ROOT -> Uint8Array
const open = new Map(); // fd -> { data, position }
let nextFD = 100;
let serial = 0;

/** Stores `fileList` (a FileList or File[]); resolves to the absolute paths
 *  Swift reads them at ("/tmp/uui-import/<n>/<name>"). */
export async function storeFiles(fileList) {
  const paths = [];
  for (const file of Array.from(fileList || [])) {
    serial += 1;
    const name = (file.name || "file").replace(/\//g, "_");
    const relative = `${serial}/${name}`;
    files.set(relative, new Uint8Array(await file.arrayBuffer()));
    paths.push(`${ROOT}/${relative}`);
  }
  return paths;
}

/** WASI overrides (swift_ffi's `wasi` option, given the memory accessor). */
export function importedFilesWasi(getMemory) {
  const view = () => new DataView(getMemory().buffer);
  const bytes = () => new Uint8Array(getMemory().buffer);
  const pathAt = (ptr, len) => new TextDecoder().decode(bytes().subarray(ptr, ptr + len)).replace(/^\.\//, "");
  const isDirectory = (path) => path === "" || path === "." || [...files.keys()].some((k) => k.startsWith(path + "/"));
  const writeStat = (buf, type, size) => {
    const v = view();
    for (let i = 0; i < 64; i++) v.setUint8(buf + i, 0);
    v.setUint8(buf + 16, type);
    v.setBigUint64(buf + 24, 1n, true);
    v.setBigUint64(buf + 32, BigInt(size), true);
  };
  return {
    fd_prestat_get: (fd, buf) => {
      if (fd !== PREOPEN_FD) return EBADF;
      view().setUint8(buf, 0);
      view().setUint32(buf + 4, ROOT.length, true);
      return SUCCESS;
    },
    fd_prestat_dir_name: (fd, ptr, len) => {
      if (fd !== PREOPEN_FD) return EBADF;
      bytes().set(new TextEncoder().encode(ROOT).subarray(0, len), ptr);
      return SUCCESS;
    },
    path_open: (dirfd, _dirflags, pathPtr, pathLen, oflags, _rightsBase, _rightsInheriting, _fdflags, fdOut) => {
      if (dirfd !== PREOPEN_FD) return EBADF;
      if (oflags & 1 /* CREAT */ || oflags & 8 /* TRUNC */) return EROFS;
      const path = pathAt(pathPtr, pathLen);
      const data = files.get(path);
      if (!data && !isDirectory(path)) return ENOENT;
      const fd = nextFD++;
      open.set(fd, { data: data || null, position: 0 });
      view().setUint32(fdOut, fd, true);
      return SUCCESS;
    },
    path_filestat_get: (dirfd, _flags, pathPtr, pathLen, buf) => {
      if (dirfd !== PREOPEN_FD) return EBADF;
      const path = pathAt(pathPtr, pathLen);
      const data = files.get(path);
      if (data) { writeStat(buf, FILETYPE_REGULAR, data.length); return SUCCESS; }
      if (isDirectory(path)) { writeStat(buf, FILETYPE_DIRECTORY, 0); return SUCCESS; }
      return ENOENT;
    },
    fd_fdstat_get: (fd, stat) => {
      const v = view();
      for (let i = 0; i < 24; i++) v.setUint8(stat + i, 0);
      const entry = open.get(fd);
      if (fd === PREOPEN_FD || (entry && !entry.data)) v.setUint8(stat, FILETYPE_DIRECTORY);
      else if (entry) v.setUint8(stat, FILETYPE_REGULAR);
      if (fd === PREOPEN_FD || entry) {
        v.setBigUint64(stat + 8, 0xffffffffffffffffn, true);
        v.setBigUint64(stat + 16, 0xffffffffffffffffn, true);
      }
      return SUCCESS;
    },
    fd_filestat_get: (fd, buf) => {
      const entry = open.get(fd);
      if (fd === PREOPEN_FD) { writeStat(buf, FILETYPE_DIRECTORY, 0); return SUCCESS; }
      if (!entry) return EBADF;
      writeStat(buf, entry.data ? FILETYPE_REGULAR : FILETYPE_DIRECTORY, entry.data ? entry.data.length : 0);
      return SUCCESS;
    },
    fd_read: (fd, iovs, count, nread) => {
      const entry = open.get(fd);
      let total = 0;
      if (entry && entry.data) {
        for (let i = 0; i < count; i++) {
          const ptr = view().getUint32(iovs + i * 8, true);
          const len = view().getUint32(iovs + i * 8 + 4, true);
          const chunk = entry.data.subarray(entry.position, entry.position + len);
          bytes().set(chunk, ptr);
          entry.position += chunk.length;
          total += chunk.length;
          if (chunk.length < len) break;
        }
      }
      view().setUint32(nread, total, true);
      return SUCCESS;
    },
    fd_pread: (fd, iovs, count, offset, nread) => {
      const entry = open.get(fd);
      if (!entry || !entry.data) return EBADF;
      let position = Number(offset);
      let total = 0;
      for (let i = 0; i < count; i++) {
        const ptr = view().getUint32(iovs + i * 8, true);
        const len = view().getUint32(iovs + i * 8 + 4, true);
        const chunk = entry.data.subarray(position, position + len);
        bytes().set(chunk, ptr);
        position += chunk.length;
        total += chunk.length;
      }
      view().setUint32(nread, total, true);
      return SUCCESS;
    },
    fd_seek: (fd, offset, whence, newOffset) => {
      const entry = open.get(fd);
      if (!entry) { view().setBigUint64(newOffset, 0n, true); return SUCCESS; }
      const size = entry.data ? entry.data.length : 0;
      const base = whence === 0 ? 0 : whence === 1 ? entry.position : size;
      const next = base + Number(offset);
      if (next < 0) return EINVAL;
      entry.position = next;
      view().setBigUint64(newOffset, BigInt(next), true);
      return SUCCESS;
    },
    fd_close: (fd) => { open.delete(fd); return SUCCESS; },
  };
}
