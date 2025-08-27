require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const { client } = require('@gradio/client');

// --- IMPORTANT SETUP ---
// 1. Firebase Admin SDK Configuration
//    - Go to your Firebase project settings > Service accounts.
//    - Click "Generate new private key" and download the JSON file.
//    - Rename it to `serviceAccountKey.json` and place it in this `server` directory.
//    - **NEVER commit this file to version control.** Add `server/serviceAccountKey.json` to your `.gitignore`.
const serviceAccount = {
  type: process.env.TYPE,
  project_id: process.env.PROJECT_ID,
  private_key_id: process.env.PRIVATE_KEY_ID,
  private_key: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.CLIENT_EMAIL,
  client_id: process.env.CLIENT_ID,
  auth_uri: process.env.AUTH_URI,
  token_uri: process.env.TOKEN_URI,
  auth_provider_x509_cert_url: process.env.AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.CLIENT_X509_CERT_URL,
  universe_domain: process.env.UNIVERSE_DOMAIN,
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const auth = admin.auth();

// 2. Nodemailer (Email) Configuration
//    - Create a `.env` file in this `server` directory.
//    - Add your email service credentials to the `.env` file like this:
//      EMAIL_HOST=smtp.example.com
//      EMAIL_PORT=587
//      EMAIL_USER=your-email@example.com
//      EMAIL_PASS=your-email-password
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT || "587", 10),
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: {
    rejectUnauthorized: false
  }
});

const app = express();
app.use(cors());
app.use(express.json());

// --- API Endpoint to Create a New Technician ---
app.post('/create-user', async (req, res) => {
  const { email, name } = req.body;

  if (!email || !name) {
    return res.status(400).json({ error: 'Email and name are required.' });
  }

  try {
    // 1. Create user in Firebase Authentication
    const userRecord = await auth.createUser({
      email,
      emailVerified: false,
      // A temporary password is required, but the user will reset it.
      password: 'temporaryPassword123', 
      displayName: name,
      disabled: false,
    });

    // 2. Create user document in Firestore
    await db.collection('users').doc(userRecord.uid).set({
      name,
      email,
      role: 'technician',
    });

    // 3. Generate password reset link
    const link = await auth.generatePasswordResetLink(email);

    // 4. Send welcome email
    const mailOptions = {
      from: `"MedTech" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Welcome! Set up your account.',
      html: `
        <h1>Welcome, ${name}!</h1>
        <p>An account has been created for you. Please set your password by clicking the link below:</p>
        <a href="${link}">Set Password</a>
        <p>This link is valid for 1 hour.</p>
        <p>After setting your password, you can log in to the application.</p>
      `,
    };

    await transporter.sendMail(mailOptions);

    res.status(201).json({ message: 'User created successfully. Welcome email sent.' });
  } catch (error) {
    console.error('Full error object:', error);
    res.status(500).json({ 
        error: 'Failed to create user and send email.',
        details: error.message 
    });
  }
});

// --- API Endpoint to Resend Welcome Email ---
app.post('/resend-invite', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required.' });
  }

  try {
    const user = await auth.getUserByEmail(email);
    const link = await auth.generatePasswordResetLink(email);

    const mailOptions = {
      from: `"MedTech" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Action Required: Set up your account.',
      html: `
        <h1>Hi ${user.displayName || ''}!</h1>
        <p>Here is a new link to set your password. Please click the link below:</p>
        <a href="${link}">Set Password</a>
        <p>This link is valid for 1 hour.</p>
      `,
    };

    await transporter.sendMail(mailOptions);

    res.status(200).json({ message: 'Password reset email sent successfully.' });
  } catch (error) {
    console.error('Full error object:', error);
    res.status(500).json({
      error: 'Failed to send password reset email.',
      details: error.message
    });
  }
});

// --- API Endpoint to Send Service Notification Email ---
app.post('/send-service-email', async (req, res) => {
  const { technicianEmail, deviceName, scheduledDate, technicianName } = req.body;

  if (!technicianEmail || !deviceName || !scheduledDate || !technicianName) {
    return res.status(400).json({ error: 'Missing required fields for sending email.' });
  }

  const mailOptions = {
    from: `"MedTech Notification" <${process.env.EMAIL_USER}>`,
    to: technicianEmail,
    subject: `New Service Task Assigned: ${deviceName}`,
    html: `
      <h1>New Service Task</h1>
      <p>Hello ${technicianName},</p>
      <p>A new service task has been assigned to you for the device: <strong>${deviceName}</strong>.</p>
      <p>The service is scheduled for: <strong>${new Date(scheduledDate).toLocaleDateString()}</strong>.</p>
      <p>Please log in to the dashboard to view the full details.</p>
      <p>Thank you,</p>
      <p>MedTech Administration</p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: 'Service notification email sent successfully.' });
  } catch (error) {
    console.error('Error sending service email:', error);
    res.status(500).json({
      error: 'Failed to send service notification email.',
      details: error.message,
    });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// --- API Endpoint to Get Predictions ---
app.post('/predict', async (req, res) => {
  const { devices } = req.body;

  if (!devices || !Array.isArray(devices)) {
    return res.status(400).json({ error: 'Invalid input. "devices" should be an array.' });
  }

  try {
    const serviceRecordsSnapshot = await db.collection('serviceRecords').get();
    const serviceRecords = serviceRecordsSnapshot.docs.map(doc => doc.data());

    const modelInput = devices.map(device => {
      const serviceRecord = serviceRecords.find(record => record.deviceId === device.id);
      return {
        device_id: parseInt(device.deviceId.replace(/[^0-9]/g, ''), 10) || 0,
        type: device.type,
        country_event: device.country_event,
        country_device: device.country_device,
        manufacturer_id: device.manufacturer_id,
        name: device.name,
        year: device.year,
        quantity_in_commerce: device.quantity_in_commerce,
        reason: serviceRecord?.reason || 'N/A',
        description: serviceRecord?.description || 'N/A',
      };
    });

    console.log("Model Input Parameters:", JSON.stringify(modelInput, null, 2));

    const gradioClient = await client("Hari1427/Fault_device_prediction");
    const result = await gradioClient.predict("/predict", {
      input_data_json: JSON.stringify(modelInput),
    });

    console.log("Model Response:", JSON.stringify(result, null, 2));

    // The model returns a JSON string inside an array, so we need to parse it
    const predictions = JSON.parse(result.data[0]);

    // Assuming result.data is an array of predictions in the same order as devices
    const predictionsWithIds = predictions.map((prediction, index) => {
      const device = devices[index];
      return {
        ...prediction,
        id: device.id, // Firestore document ID
        deviceId: device.deviceId, // The device's own ID (e.g., "VENT-004")
      };
    });

    const enhancedResult = { ...result, data: predictionsWithIds };

    res.status(200).json(enhancedResult);
  } catch (error) {
    console.error('Error fetching predictions:', error);
    res.status(500).json({
      error: 'Failed to fetch predictions from the model.',
      details: error.message,
    });
  }
});
