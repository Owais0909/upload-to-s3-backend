const express = require("express");
const bodyParser = require("body-parser");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config();

// Constants
const PORT = process.env.PORT || 5000;
const BODY_SIZE_LIMIT = "50mb";
const DEFAULT_IMAGE_EXTENSION = "jpg";
const JOURNEY_TYPES = {
  PRE_INSPECTION: "PRE_INSPECTION",
  PRE_INSPECTION_PRDP: "PRE_INSPECTION_PRDP",
};

// Validate required environment variables
const requiredEnvVars = [
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "S3_BUCKET_NAME",
];

const missingEnvVars = requiredEnvVars.filter((key) => !process.env[key]);
if (missingEnvVars.length > 0) {
  console.error(
    `❌ Missing required environment variables: ${missingEnvVars.join(", ")}`
  );
  process.exit(1);
}

// AWS S3 Configuration
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.S3_BUCKET_NAME;

// Initialize Express app
const app = express();

// Configure body parser with increased limit for base64 images
app.use(bodyParser.json({ limit: BODY_SIZE_LIMIT }));
app.use(bodyParser.urlencoded({ extended: true, limit: BODY_SIZE_LIMIT }));

/**
 * Sanitize mobile number for folder name
 * Keeps only alphanumeric characters and +, replaces other special chars with underscore
 * Example: "+1234567890" → "+1234567890"
 */
function sanitizeMobileNumber(mobileNumber) {
  if (!mobileNumber || typeof mobileNumber !== "string") return "unknown";
  let sanitized = mobileNumber.replace(/[^a-zA-Z0-9+]/g, "_");
  sanitized = sanitized.replace(/_+/g, "_"); // Remove multiple consecutive underscores
  sanitized = sanitized.replace(/^_+|_+$/g, ""); // Remove leading/trailing underscores
  return sanitized || "unknown";
}

/**
 * Sanitize UUID for folder name
 * Keeps only alphanumeric characters, hyphens, underscores, and spaces
 */
function sanitizeUuid(uuid) {
  if (!uuid) return null;
  return String(uuid).replace(/[^a-zA-Z0-9\-_ ]/g, "").trim();
}

/**
 * Format file size in KB
 */
function formatSizeKB(bytes) {
  return (bytes / 1024).toFixed(2);
}

/**
 * Get content type for image extension
 */
function getImageContentType(extension) {
  const ext = (extension || DEFAULT_IMAGE_EXTENSION).toLowerCase();
  const contentTypes = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  return contentTypes[ext] || `image/${ext}`;
}

/**
 * Validate screenshot object
 */
function validateScreenshot(screenshot, index) {
  if (!screenshot || typeof screenshot !== "object") {
    return { valid: false, error: `Screenshot at index ${index} is not an object` };
  }
  if (!screenshot.filename || typeof screenshot.filename !== "string") {
    return { valid: false, error: `Screenshot at index ${index} missing filename` };
  }
  if (!screenshot.image || typeof screenshot.image !== "string") {
    return { valid: false, error: `Screenshot at index ${index} missing image data` };
  }
  return { valid: true };
}

/**
 * Handle error response consistently
 */
function sendErrorResponse(res, statusCode, message, details = null) {
  const response = { error: message };
  if (details) {
    response.details = details;
  }
  return res.status(statusCode).json(response);
}

/**
 * BATCH Upload Endpoint (OPTIMIZED)
 * Receives multiple screenshots in a single request
 * Most efficient for batch processing - reduces HTTP overhead by 80%+
 * Creates folders by mobile number and assessment ID for better organization
 *
 * Request body format:
 * {
 *   mobileNumber: "+1234567890",  // Optional: Mobile number for folder organization
 *   inspectionUuid: "123",  // Required: Inspection UUID for folder organization
 *   prdpUuid: "456",  // Optional: PRDP UUID for folder organization
 *   journeyType: "PRE_INSPECTION_PRDP",  // Optional: Journey type
 *   screenshots: [
 *     { filename: 'name1', extension: 'jpg', timestamp: 123, image: 'base64...' },
 *     { filename: 'name2', extension: 'jpg', timestamp: 456, image: 'base64...' }
 *   ]
 * }
 *
 * Folder structure: {mobileNumber}/{inspectionUuid}/{childFolderUuid}/
 * - PRE_INSPECTION: MobileNumber/InspectionUUID/InspectionUUID
 * - PRE_INSPECTION_PRDP: MobileNumber/InspectionUUID/PRDPUUID
 */
app.post("/upload-batch", async (req, res) => {
  try {
    const { mobileNumber, inspectionUuid, prdpUuid, journeyType, screenshots } =
      req.body;

    // Debug logging
    console.log("\n═══════════════════════════════════════════════════════");
    console.log("📥 BATCH UPLOAD REQUEST RECEIVED");
    console.log("═══════════════════════════════════════════════════════");
    console.log(`  📱 Mobile Number (raw): ${mobileNumber || "Not provided"}`);
    console.log(
      `  📋 Inspection UUID (raw): ${inspectionUuid || "Not provided"}`
    );
    console.log(`  📋 PRDP UUID (raw): ${prdpUuid || "Not provided"}`);
    console.log(`  📋 Journey Type (raw): ${journeyType || "Not provided"}`);
    console.log(`  📦 Screenshots count: ${screenshots?.length || 0}`);
    console.log("═══════════════════════════════════════════════════════\n");

    // Validate screenshots array
    if (!screenshots || !Array.isArray(screenshots) || screenshots.length === 0) {
      return sendErrorResponse(res, 400, "Missing or invalid screenshots array");
    }

    // Validate array size to prevent abuse
    const MAX_BATCH_SIZE = 100;
    if (screenshots.length > MAX_BATCH_SIZE) {
      return sendErrorResponse(
        res,
        400,
        `Batch size exceeds maximum of ${MAX_BATCH_SIZE} files`
      );
    }

    // Sanitize mobile number and UUIDs
    const sanitizedMobileNumber = sanitizeMobileNumber(mobileNumber);
    const sanitizedInspectionUuid = sanitizeUuid(inspectionUuid);
    const sanitizedPrdpUuid = sanitizeUuid(prdpUuid);

    console.log("📋 SANITIZED VALUES:");
    console.log(`  📱 Mobile Number (sanitized): ${sanitizedMobileNumber}`);
    console.log(
      `  📋 Inspection UUID (sanitized): ${sanitizedInspectionUuid || "null"}`
    );
    console.log(`  📋 PRDP UUID (sanitized): ${sanitizedPrdpUuid || "null"}`);
    console.log(`  📋 Journey Type: ${journeyType || "Not provided"}`);

    // Create folder structure based on journey type:
    // - PRE_INSPECTION: MobileNumber/InspectionUUID/InspectionUUID
    // - PRE_INSPECTION_PRDP: MobileNumber/InspectionUUID/PRDPUUID
    if (!sanitizedInspectionUuid) {
      return sendErrorResponse(res, 400, "Inspection UUID is required");
    }

    // Determine child folder based on journey type
    let childFolderUuid;
    if (
      journeyType === JOURNEY_TYPES.PRE_INSPECTION_PRDP &&
      sanitizedPrdpUuid
    ) {
      // For PRDP journeys: use PRDP UUID as child folder
      childFolderUuid = sanitizedPrdpUuid;
    } else {
      // For Inspection journeys: use Inspection UUID as child folder
      childFolderUuid = sanitizedInspectionUuid;
    }

    // Create S3 key folder structure: {mobileNumber}/{inspectionUuid}/{childFolderUuid}/
    const folderPath = `${sanitizedMobileNumber}/${sanitizedInspectionUuid}/${childFolderUuid}`;

    console.log("═══════════════════════════════════════════════════════");
    console.log("📁 S3 FOLDER STRUCTURE");
    console.log("═══════════════════════════════════════════════════════");
    console.log(`  📂 S3 Path: ${folderPath}/`);
    console.log(`  📋 Journey Type: ${journeyType || "Not provided"}`);
    console.log(`  📦 S3 Bucket: ${BUCKET}`);
    console.log("═══════════════════════════════════════════════════════\n");

    console.log(
      `[BATCH] Processing ${screenshots.length} screenshots for ${folderPath}...`
    );

    const results = {
      successful: 0,
      failed: 0,
      total: screenshots.length,
      details: [],
      userFolder: folderPath,
      mobileNumber: sanitizedMobileNumber,
      inspectionUuid: sanitizedInspectionUuid,
      prdpUuid: sanitizedPrdpUuid || null,
      journeyType: journeyType || null,
    };

    const startTime = Date.now();

    // Process each screenshot in the batch
    for (let i = 0; i < screenshots.length; i++) {
      const screenshot = screenshots[i];
      const { filename, extension, timestamp, image } = screenshot;

      // Validate screenshot before processing
      const validation = validateScreenshot(screenshot, i);
      if (!validation.valid) {
        results.failed++;
        results.details.push({
          index: i,
          filename: screenshot?.filename || "unknown",
          status: "failed",
          error: validation.error,
        });
        console.error(`  [${i + 1}/${screenshots.length}] ❌ ${validation.error}`);
        continue;
      }

      try {
        // Decode base64 and upload to S3
        let buffer;
        try {
          buffer = Buffer.from(image, "base64");
          if (buffer.length === 0) {
            throw new Error("Empty image data");
          }
        } catch (error) {
          throw new Error(`Invalid base64 data: ${error.message}`);
        }

        const imageExtension = extension || DEFAULT_IMAGE_EXTENSION;
        const key = `${folderPath}/${filename}.${imageExtension}`;

        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            Body: buffer,
            ContentType: getImageContentType(imageExtension),
          })
        );

        results.successful++;
        results.details.push({
          index: i,
          filename: `${filename}.${imageExtension}`,
          key: key,
          status: "success",
          size: buffer.length,
          sizeKB: formatSizeKB(buffer.length),
        });

        console.log(
          `  [${i + 1}/${screenshots.length}] ✅ ${filename}.${imageExtension} (${formatSizeKB(buffer.length)} KB) → s3://${BUCKET}/${key}`
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
    const avgTimePerFile =
      screenshots.length > 0
        ? (duration / screenshots.length).toFixed(2)
        : "0.00";

    console.log(
      `[BATCH] Complete: ${results.successful}/${results.total} successful in ${duration}ms (${avgTimePerFile}ms/file) → S3: ${folderPath}/`
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
    sendErrorResponse(res, 500, "Batch upload failed", error.message);
  }
});

/**
 * Health Check
 */
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Screenshot upload server (S3 version) running",
    bucket: BUCKET,
    region: process.env.AWS_REGION,
    endpoints: ["/upload-batch"],
    timestamp: new Date().toISOString(),
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("[ERROR] Unhandled error:", err);
  if (!res.headersSent) {
    sendErrorResponse(res, 500, "Internal server error", err.message);
  }
});

// 404 handler
app.use((req, res) => {
  sendErrorResponse(res, 404, "Endpoint not found");
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Screenshot Upload Server running on http://0.0.0.0:${PORT}`);
  console.log(`📦 S3 Bucket: ${BUCKET}`);
  console.log(`🌍 AWS Region: ${process.env.AWS_REGION}`);
  console.log(`\nAvailable endpoints:`);
  console.log(`  - POST /upload-batch (Batch JSON Upload) ⚡ OPTIMIZED`);
  console.log(`  - GET / (Health Check)`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("\n⚠️  SIGTERM received, shutting down gracefully...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("\n⚠️  SIGINT received, shutting down gracefully...");
  process.exit(0);
});

