const express = require("express");
const bodyParser = require("body-parser");
const multer = require("multer");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config();

const app = express();
const PORT = 5000;

// AWS S3 Configuration
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});
const BUCKET = process.env.S3_BUCKET_NAME;

// Configure body parser with increased limit for base64 images
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));

// Configure multer for FormData uploads (store in memory)
const upload = multer({ storage: multer.memoryStorage() });

/** 🔹 METHOD 1: JSON Upload (base64) */
app.post("/upload-json", async (req, res) => {
  try {
    const { filename, extension = "jpg", timestamp, image } = req.body;
    if (!filename || !image)
      return res.status(400).json({ error: "Missing filename or image data" });

    const buffer = Buffer.from(image, "base64");
    const key = `${Date.now()}-${filename}.${extension}`;

    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: buffer,
        ContentType: `image/${extension}`,
      })
    );

    console.log(
      `[JSON] Uploaded ${key} (${(buffer.length / 1024).toFixed(2)} KB)`
    );

    res.json({
      message: "Upload successful (JSON → S3)",
      key,
      bucket: BUCKET,
      size: buffer.length,
      timestamp,
    });
  } catch (error) {
    console.error("JSON upload error:", error);
    res.status(500).json({ error: "Upload failed", details: error.message });
  }
});

/** 🔹 METHOD 2: FormData Upload */
app.post("/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const extension = path.extname(req.file.originalname).slice(1) || "jpg";
    const key = `${Date.now()}-${req.file.originalname}`;

    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      })
    );

    console.log(
      `[FormData] Uploaded ${key} (${(req.file.size / 1024).toFixed(2)} KB)`
    );

    res.json({
      message: "Upload successful (FormData → S3)",
      key,
      bucket: BUCKET,
      size: req.file.size,
      timestamp: req.body.timestamp || Date.now(),
    });
  } catch (error) {
    console.error("FormData upload error:", error);
    res.status(500).json({ error: "Upload failed", details: error.message });
  }
});

/** 🔹 METHOD 3: Binary Upload */
app.post("/upload-binary", async (req, res) => {
  try {
    const filename = req.headers["x-filename"];
    const timestamp = req.headers["x-timestamp"];
    const contentType = req.headers["content-type"];
    if (!filename)
      return res.status(400).json({ error: "Missing filename in headers" });

    const extension = contentType?.split("/")[1] || "jpg";
    const key = `${Date.now()}-${filename}.${extension}`;
    const chunks = [];

    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const buffer = Buffer.concat(chunks);

      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: buffer,
          ContentType: contentType,
        })
      );

      console.log(
        `[Binary] Uploaded ${key} (${(buffer.length / 1024).toFixed(2)} KB)`
      );

      res.json({
        message: "Upload successful (Binary → S3)",
        key,
        bucket: BUCKET,
        size: buffer.length,
        timestamp,
      });
    });
  } catch (error) {
    console.error("Binary upload error:", error);
    res.status(500).json({ error: "Upload failed", details: error.message });
  }
});

/** 🔹 Health Check */
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Screenshot upload server (S3 version) running",
    bucket: BUCKET,
    endpoints: ["/upload-json", "/upload", "/upload-binary"],
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 S3 Upload Server running at http://0.0.0.0:${PORT}`);
});
