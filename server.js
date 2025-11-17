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

/** 🔹 METHOD 4: BATCH Upload (OPTIMIZED) */
app.post("/upload-batch", async (req, res) => {
  try {
    const { screenshots } = req.body;
    if (
      !screenshots ||
      !Array.isArray(screenshots) ||
      screenshots.length === 0
    ) {
      return res
        .status(400)
        .json({ error: "Missing or invalid screenshots array" });
    }

    console.log(`\n[BATCH] Processing ${screenshots.length} screenshots...`);

    const results = {
      successful: 0,
      failed: 0,
      total: screenshots.length,
      details: [],
    };

    const startTime = Date.now();

    // Process each screenshot in the batch
    for (let i = 0; i < screenshots.length; i++) {
      const screenshot = screenshots[i];
      const { filename, extension, timestamp, image } = screenshot;

      try {
        if (!filename || !image) {
          throw new Error("Missing filename or image data");
        }

        // Decode base64 and upload to S3
        const buffer = Buffer.from(image, "base64");
        const key = `${Date.now()}-${filename}.${extension || "jpg"}`;

        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            Body: buffer,
            ContentType: `image/${extension || "jpg"}`,
          })
        );

        results.successful++;
        results.details.push({
          index: i,
          filename: `${filename}.${extension || "jpg"}`,
          key: key,
          status: "success",
          size: buffer.length,
          sizeKB: (buffer.length / 1024).toFixed(2),
        });

        console.log(
          `  [${i + 1}/${screenshots.length}] ✅ ${filename}.${extension} (${(
            buffer.length / 1024
          ).toFixed(2)} KB)`
        );
      } catch (error) {
        results.failed++;
        results.details.push({
          index: i,
          filename: filename || "unknown",
          status: "failed",
          error: error.message,
        });
        console.error(
          `  [${i + 1}/${screenshots.length}] ❌ ${filename || "unknown"}: ${
            error.message
          }`
        );
      }
    }

    const duration = Date.now() - startTime;
    const avgTimePerFile = (duration / screenshots.length).toFixed(2);

    console.log(
      `[BATCH] Complete: ${results.successful}/${results.total} successful in ${duration}ms (${avgTimePerFile}ms/file)`
    );

    // Return success if at least one file was uploaded
    const statusCode = results.successful > 0 ? 200 : 500;
    res.status(statusCode).json({
      message: `Batch upload: ${results.successful}/${results.total} successful`,
      bucket: BUCKET,
      ...results,
      duration,
      avgTimePerFile,
    });
  } catch (error) {
    console.error("[BATCH] Upload error:", error);
    res
      .status(500)
      .json({ error: "Batch upload failed", details: error.message });
  }
});

/** 🔹 Health Check */
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Screenshot upload server (S3 version) running",
    bucket: BUCKET,
    endpoints: ["/upload-json", "/upload", "/upload-binary", "/upload-batch"],
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 S3 Upload Server running at http://0.0.0.0:${PORT}`);
  console.log(`📦 S3 Bucket: ${BUCKET}`);
  console.log(`\nAvailable endpoints:`);
  console.log(`  - POST /upload-json (JSON + Base64)`);
  console.log(`  - POST /upload (FormData Multipart)`);
  console.log(`  - POST /upload-binary (Raw Binary)`);
  console.log(`  - POST /upload-batch (Batch JSON Upload) ⚡ OPTIMIZED`);
  console.log(`  - GET / (Health Check)`);
});
