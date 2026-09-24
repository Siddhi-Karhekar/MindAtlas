import multer from "multer";

/**
 * multer's single-file upload, but with its errors turned into proper 4xx
 * responses. Without this, a file over the size limit reaches the app's
 * catch-all error handler and the student just sees "internal server error".
 */
export function uploadSingle(field, maxMb) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxMb * 1024 * 1024 } }).single(field);
  return (req, res, next) =>
    upload(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ error: `file too large - the limit is ${maxMb} MB` });
        }
        return res.status(400).json({ error: `upload failed: ${err.message}` });
      }
      next(err);
    });
}
