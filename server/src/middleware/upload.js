import multer from "multer";
import { checkFormFields } from "./validate.js";

/**
 * multer's single-file upload, with its errors turned into proper 4xx
 * responses (without this, a file over the size limit reaches the app's
 * catch-all error handler and the student just sees "internal server error")
 * and with limits on everything else a multipart request can carry: one file,
 * a handful of short text fields. The file is held in memory and never
 * written to disk, so its name is never used as a path.
 */
export function uploadSingle(field, limitMb) {
  // a number, or a function that reads the setting (config.uploadMaxMb)
  const sizeMb = () => (typeof limitMb === "function" ? limitMb() : limitMb);
  const uploaders = new Map();
  const uploaderFor = (mb) => {
    if (!uploaders.has(mb)) {
      uploaders.set(
        mb,
        multer({
          storage: multer.memoryStorage(),
          limits: { fileSize: mb * 1024 * 1024, files: 1, fields: 8, fieldSize: 16 * 1024, parts: 10, fieldNameSize: 64 },
        }).single(field)
      );
    }
    return uploaders.get(mb);
  };
  return (req, res, next) => {
    const maxMb = sizeMb();
    // refused before the body is read when the browser says how big it is
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxMb * 1024 * 1024 + 64 * 1024) {
      return res.status(413).json({ error: `file too large - the limit is ${maxMb} MB per file`, code: "file_too_large", maxMb });
    }
    return uploaderFor(maxMb)(req, res, (err) => {
      if (!err) {
        try {
          checkFormFields(req.body);
        } catch (bad) {
          return next(bad);
        }
        return next();
      }
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ error: `file too large - the limit is ${maxMb} MB per file`, code: "file_too_large", maxMb });
        }
        if (err.code === "LIMIT_UNEXPECTED_FILE" || err.code === "LIMIT_FILE_COUNT") {
          return res.status(400).json({ error: "send one file, in the field named \"file\"" });
        }
        return res.status(400).json({ error: "the upload could not be read - try again" });
      }
      next(err);
    });
  };
}
