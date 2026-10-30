// Hand a file to the browser to save. The link is clicked from code because
// the file comes from a request that carries the sign-in token, which a plain
// <a href> cannot send.
export function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // let the download start before the address is given back
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
