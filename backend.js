require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const DynamoDBStore = require('connect-dynamodb')(session);
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
require('dotenv').config();
const storage = multer.memoryStorage();
// Explicitly allow 100MB file size
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 } 
});

const { SESv2Client, SendEmailCommand } = require("@aws-sdk/client-sesv2");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, GetCommand, ScanCommand, UpdateCommand, DeleteCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const chatRoute = require('./chatRoute'); 
const router = express.Router();

// const Razorpay = require('razorpay'); // Payment Disabled for now
const Razorpay = require('razorpay');
const crypto = require('crypto'); // Built-in Node module for security
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

const app = express();

// --- 1. CONFIGURATION ---
app.use(bodyParser.json({ limit: '100mb' }));
app.use(bodyParser.urlencoded({ limit: '100mb', extended: true }));

app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        // Specific Multer errors
        if (err.code === 'LIMIT_FILE_SIZE') {
            console.error("Upload failed: File too large (>100MB)");
            return res.status(413).json({ error: 'File is too large! Maximum limit is 100MB.' });
        }
        return res.status(400).json({ error: `Upload Error: ${err.message}` });
    } else if (err) {
        // General errors
        console.error("Server Error:", err);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
    next();
});

// --- SERVE ASSETS & SCRIPTS (SECURE) ---
app.use('/assets', express.static(path.join(__dirname, 'assets')));
// Point to public/js instead of just js
app.use('/js', express.static(path.join(__dirname, 'public/js')));
// Point to public/static instead of just static
app.use('/static', express.static(path.join(__dirname, 'public/static')));

app.use(session({
    store: new DynamoDBStore({
        table: 'Lakshya_Sessions',
        AWSConfigJSON: { 
            region: 'ap-south-1',
            // Hardcoded credentials for the DynamoDB account
            accessKeyId: 'AKIAWJL64KMIFX67RTPV', 
            secretAccessKey: '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'
        }
    }),
    secret: process.env.SESSION_SECRET || 'lakshya_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false, 
        maxAge: 24 * 60 * 60 * 1000 
    }
}));

// --- RAZORPAY SETUP ---
// --- RAZORPAY SETUP ---
// Define keys in variables first so we can reuse them
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_missing_key'; 
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'missing_secret';

if (RAZORPAY_KEY_ID === 'rzp_test_missing_key') {
    console.warn("⚠️ WARNING: RAZORPAY_KEY_ID is missing from .env file. Payment features will not work.");
}

const razorpay = new Razorpay({
    key_id: RAZORPAY_KEY_ID,
    key_secret: RAZORPAY_KEY_SECRET
});

// --- 2. AWS SETUP (UPDATED WITH YOUR CREDENTIALS) ---

// DynamoDB Setup
const client = new DynamoDBClient({
    region: 'ap-south-1',
    credentials: {
        accessKeyId: 'AKIAWJL64KMIFX67RTPV',
        secretAccessKey: 'tJdzcwujjRULVCCJBc53AFjp0RPosxYwkH5zsqla'
    }
});
const docClient = DynamoDBDocumentClient.from(client);

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
        accessKeyId: 'AKIAWJL64KMIFX67RTPV',
        secretAccessKey: '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'
    }
});

// SES Setup
const sesClient = new SESv2Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
        accessKeyId: process.env.AWS_SES_ACCESS_KEY_ID || 'AKIAS2VS4CZ2Q4RQV4WX',
        secretAccessKey: process.env.AWS_SES_SECRET_ACCESS_KEY || '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'
    }
});


function isEligibleForCombo(event) {
    if (!event) return false;
    
    // Normalize strings for checking
    const t = (event.type || '').toLowerCase();
    const ti = (event.title || '').toLowerCase();
    const f = parseInt(event.fee || '0');
    
    // RULE 1: STRICTLY EXCLUDE "SPECIAL" EVENTS
    if (t.includes('special') || ti.includes('special')) {
        return false;
    }

    // RULE 2: ALLOWED TYPES
    const eligibleKeywords = [
        'major', 'mba', 'management', 
        'cultural', 'music', 'dance', 'singing', 'drama', 'art', 'fashion', 'literary'
    ];
    
    const isTargetType = eligibleKeywords.some(k => t.includes(k) || ti.includes(k));

    // RULE 3: MUST HAVE A FEE
    return isTargetType && f > 0;
}

const checkKitEligibility = (category) => {
    if (!category) return false;
    const lowerCat = category.toLowerCase().trim();
    // STRICT RULE: Kits only for Major, MBA, and Culturals
    return ['major', 'mba', 'culturals'].includes(lowerCat);
};

// --- 3. HELPER FUNCTIONS ---

// Send Email via SES (Updated Logic)
async function sendEmail(to, subject, htmlContent) {
    const toAddresses = Array.isArray(to) ? to : to.split(',').map(e => e.trim());

    const params = {
        FromEmailAddress: '"LAKSHYA 2K26" <events@xetasolutions.in>', 
        Destination: { ToAddresses: toAddresses },
        Content: {
            Simple: {
                Subject: { Data: subject, Charset: 'UTF-8' },
                Body: { Html: { Data: htmlContent, Charset: 'UTF-8' } },
            },
        },
    };

    try {
        const command = new SendEmailCommand(params);
        await sesClient.send(command);
        return true;
    } catch (error) {
        console.error('Error sending email with SES:', error);
        return false;
    }
}

async function generateCouponsForUser(email, name, sourceId) {
    const coupon1 = {
        code: `FOOD-${uuidv4().substring(0,8).toUpperCase()}`,
        holderEmail: email,
        holderName: name,
        status: 'ACTIVE',
        issuedAt: new Date().toISOString(),
        source: sourceId // e.g., RegistrationID or 'TEAM'
    };
    const coupon2 = {
        code: `FOOD-${uuidv4().substring(0,8).toUpperCase()}`,
        holderEmail: email,
        holderName: name,
        status: 'ACTIVE',
        issuedAt: new Date().toISOString(),
        source: sourceId
    };

    await docClient.send(new PutCommand({ TableName: 'Lakshya_FoodCoupons', Item: coupon1 }));
    await docClient.send(new PutCommand({ TableName: 'Lakshya_FoodCoupons', Item: coupon2 }));
}
// Middleware to check Authentication
const isAuthenticated = (role) => (req, res, next) => {
    if (req.session.user && req.session.user.role === role) {
        return next();
    }
    res.redirect('/login');
};

// --- 4. ROUTES: PUBLIC PAGES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/static/index.html')));
app.get('/home', (req, res) => res.sendFile(path.join(__dirname, 'public/static/home.html')));
app.get('/launch', (req, res) => res.sendFile(path.join(__dirname, 'public/static/launch.html')));
app.get('/intro', (req, res) => res.sendFile(path.join(__dirname, 'public/static/index.html')));
app.get('/my-coupons', (req, res) => res.sendFile(path.join(__dirname, 'public/static/my-coupons.html')));


app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public/static/login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public/static/register.html')));
app.get('/events', (req, res) => res.sendFile(path.join(__dirname, 'public/static/events.html')));
app.get('/culturals', (req, res) => res.sendFile(path.join(__dirname, 'public/static/culturals.html')));
app.get('/brochure', (req, res) => res.sendFile(path.join(__dirname, 'public/static/brochure.html')));
app.get('/committee', (req, res) => res.sendFile(path.join(__dirname, 'public/static/committee.html')));
app.get('/contact', (req, res) => res.sendFile(path.join(__dirname, 'public/static/contact.html')));
app.get('/about', (req, res) => res.sendFile(path.join(__dirname, 'public/static/about.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public/static/terms&conditions.html')));
app.get('/get-sponsors', (req, res) => res.sendFile(path.join(__dirname, 'public/static/sponsors.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public/static/privacy.html')));
app.get('/refunds', (req, res) => res.sendFile(path.join(__dirname, 'public/static/refunds.html')));
app.get('/shipping', (req, res) => res.sendFile(path.join(__dirname, 'public/static/shipping.html')));



// --- 5. ROUTES: PARTICIPANT (PROTECTED) ---
app.get('/participant/dashboard', isAuthenticated('participant'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/participant/dashboard.html'));
});
app.get('/participant/events', isAuthenticated('participant'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/participant/events.html'));
});
app.get('/participant/cart', isAuthenticated('participant'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/participant/cart.html'));
});
app.get('/participant/my-registrations', isAuthenticated('participant'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/participant/my-registrations.html'));
});
app.get('/participant/certificates', isAuthenticated('participant'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/participant/certificates.html'));
});
app.get('/participant/feedback', isAuthenticated('participant'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/participant/feedback.html'));
});
app.get('/participant/culturals', isAuthenticated('participant'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/participant/culturals.html'));
});
app.get('/participant/support', isAuthenticated('participant'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/participant/support.html'));
});
app.get('/participant/payment-success', isAuthenticated('participant'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/participant/payment-success.html'));
});

// --- 6. ROUTES: COORDINATOR (PROTECTED) ---
app.get('/coordinator/dashboard', isAuthenticated('coordinator'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/coordinator/dashboard.html'));
});
app.get('/coordinator/attendance', isAuthenticated('coordinator'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/coordinator/attendance.html'));
});
app.get('/coordinator/payment-status', isAuthenticated('coordinator'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/coordinator/payments.html'));
});
app.get('/coordinator/assign-score', isAuthenticated('coordinator'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/coordinator/assign-score.html'));
});
app.get('/coordinator/registrations', isAuthenticated('coordinator'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/coordinator/registrations.html'));
});
app.get('/coordinator/view-submissions', isAuthenticated('coordinator'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/coordinator/submissions.html'));
});
app.get('/coordinator/event-control', isAuthenticated('coordinator'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/coordinator/event-control.html'));
});
app.get('/coordinator/approvals', isAuthenticated('coordinator'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/coordinator/approvals.html'));
});
app.get('/coordinator/benficiaries', isAuthenticated('coordinator'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/coordinator/benficiaries.html'));
});
app.get('/coordinator/add-team', isAuthenticated('coordinator'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/coordinator/add-team.html'));
});

// --- 7. ROUTES: ADMIN (PROTECTED) ---
app.get('/admin/dashboard', isAuthenticated('admin'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/dashboard.html'));
});
app.get('/admin/add-event', isAuthenticated('admin'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/add-event.html'));
});
app.get('/admin/manage-users', isAuthenticated('admin'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/manage-users.html'));
});
app.get('/admin/committee', isAuthenticated('admin'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/committee.html'));
});
app.get('/admin/departments', isAuthenticated('admin'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/departments.html'));
});
app.get('/admin/setup-scoring', isAuthenticated('admin'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/setup-scoring.html'));
});
app.get('/admin/view-scores', isAuthenticated('admin'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/view-scores.html'));
});
app.get('/admin/manage-events', isAuthenticated('admin'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/manage-events.html'));
});
app.get('/admin/manage-scoring', isAuthenticated('admin'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/manage-scoring.html'));
});
app.get('/admin/coupons', isAuthenticated('admin'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/coupons.html'));
});
app.get('/admin/registrations', isAuthenticated('admin'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/registrations.html'));
});
app.get('/admin/coupon-usage', isAuthenticated('admin'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/rcoupom-manager.html'));
});
app.get('/admin/admin-kits', isAuthenticated('admin'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/admin-kits.html'));
});
app.get('/admin/querries', isAuthenticated('admin'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/admin-querries.html'));
});
app.get('/admin/all-users', isAuthenticated('admin'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/all-users.html'));
});
app.get('/admin/send-mails', isAuthenticated('admin'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/admin-broadcast.html'));
});
app.get('/admin/view-teams', isAuthenticated('admin'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/view-team.html'));
});

const getEmailTemplate = (type, data) => {
    const { title, name, regId, eventName, dept, teamName, status, amount, txId, date, coupon, link } = data;
    
    // Logic to list Team Members
    let teamHtml = '';
    if (data.teamMembers && Array.isArray(data.teamMembers) && data.teamMembers.length > 0) {
        // Create a clean comma-separated list of names
        const names = data.teamMembers.map(m => m.name).join(', ');
        teamHtml = `<p style="margin: 5px 0;"><strong>Team Members:</strong> ${names}</p>`;
    }

    if (type === 'REGISTER') {
        // TEMPLATE 1: Registration Confirmed (Matches your blue text screenshot)
        return `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; background-color: #ffffff;">
            <div style="background-color: #ffffff; padding: 20px; text-align: center; border-bottom: 3px solid #00d2ff;">
                 <h1 style="color: #00d2ff; margin: 0; font-size: 24px; font-weight: bold;">LAKSHYA 2K26</h1>
            </div>
            <div style="padding: 30px;">
                <p style="font-size: 16px; color: #333;">Dear Participant,</p>
                <p style="font-size: 16px; color: #555;">Thank you for registering for <strong>${eventName}</strong>. Below are your registration details:</p>
                
                <div style="background-color: #f9f9f9; padding: 20px; border-radius: 8px; margin-top: 20px;">
                    <p style="margin: 5px 0;"><strong>Registration ID:</strong> ${regId}</p>
                    <p style="margin: 5px 0;"><strong>Event:</strong> ${eventName}</p>
                    <p style="margin: 5px 0;"><strong>Department:</strong> ${dept}</p>
                    ${teamName ? `<p style="margin: 5px 0;"><strong>Team Name:</strong> ${teamName}</p>` : ''}
                    ${teamHtml}
                    <p style="margin: 5px 0;"><strong>Payment Status:</strong> <span style="color: ${status === 'COMPLETED' ? 'green' : '#ffc107'}; font-weight: bold;">${status === 'COMPLETED' ? 'Paid' : 'Payment Pending'}</span></p>
                </div>

                <p style="margin-top: 30px; color: #555;">Best Regards,<br>Team LAKSHYA</p>
            </div>
        </div>`;
    } 
    
    if (type === 'PAYMENT') {
        // TEMPLATE 2: Payment Confirmed (Matches your blue header screenshot)
        return `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; overflow: hidden; border-radius: 8px;">
            <div style="background-color: #00d2ff; padding: 20px; text-align: center;">
                 <h2 style="color: #ffffff; margin: 0; font-size: 22px; text-transform: uppercase; font-weight: bold;">PAYMENT CONFIRMED</h2>
            </div>
            <div style="padding: 30px; background-color: #ffffff;">
                <p style="font-size: 16px; color: #333;">Dear <strong>${name}</strong>,</p>
                <p style="font-size: 14px; color: #666;">We have successfully received your payment for <strong>${eventName}</strong>.</p>
                
                <div style="background-color: #f8f9fa; padding: 20px; border-left: 4px solid #4CAF50; margin: 20px 0; border-radius: 4px;">
                    <p style="margin: 5px 0;"><strong>Transaction ID:</strong> ${txId}</p>
                    <p style="margin: 5px 0;"><strong>Date:</strong> ${date}</p>
                    ${coupon && coupon !== 'NONE' ? `<p style="margin: 5px 0; color: #00d2ff;"><strong>Coupon Applied:</strong> ${coupon}</p>` : ''}
                    <p style="margin: 5px 0; font-size: 12px; color: #888;">(Includes Platform Fee)</p>
                </div>

                <div style="text-align: center; margin-top: 30px;">
                    <a href="${link}" target="_blank" style="background-color: #3a7bd5; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 14px;">Download Receipt</a>
                </div>
            </div>
        </div>`;
    }
};


// --- 8. API ROUTES: AUTHENTICATION ---
app.post('/api/auth/register', async (req, res) => {
    const { fullName, rollNo, email, mobile, college, password, stream, dept, year } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const params = {
        TableName: 'Lakshya_Users',
        Item: {
            email: email, role: 'participant', fullName, rollNo, mobile, college, stream, dept, year,
            password: hashedPassword, createdAt: new Date().toISOString()
        },
        // THIS LINE IS CRITICAL:
        ConditionExpression: 'attribute_not_exists(email)' 
    };

    try { 
        await docClient.send(new PutCommand(params)); 
        res.status(200).json({ message: 'Registration successful' }); 
    }
    catch (err) { 
        // Catch specific "Already Exists" error
        if (err.name === 'ConditionalCheckFailedException') {
            return res.status(409).json({ error: 'Account already exists. Please Login.' });
        }
        res.status(500).json({ error: 'Registration failed', details: err }); 
    }
});
app.post('/api/auth/login', async (req, res) => {
    const { email, password, role } = req.body;
    const params = { TableName: 'Lakshya_Users', Key: { email } };
    try {
        const data = await docClient.send(new GetCommand(params));
        const user = data.Item;
        if (!user || user.role !== role) return res.status(401).json({ error: 'Invalid credentials' });
        
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ error: 'Invalid password' });

        // --- UPDATE STARTS HERE ---
        // Logic: If 'managedEventIds' exists, use it.
        // If only old 'managedEventId' exists, wrap it in an array.
        // Otherwise empty array.
        const eventIds = user.managedEventIds || (user.managedEventId ? [user.managedEventId] : []);

        req.session.user = { 
            email: user.email, 
            role: user.role, 
            name: user.fullName,
            dept: user.dept,
            managedEventIds: eventIds // Store the ARRAY
        };
        // --- UPDATE ENDS HERE ---
        
        res.status(200).json({ message: 'Login successful' });
    } catch (err) {
        res.status(500).json({ error: 'Login failed' });
    }
});
app.post('/api/auth/send-otp', async (req, res) => {
    const { email } = req.body;

    // 0. RATE LIMITING (45 Seconds)
    // Check if OTP was sent recently to this session
    const cooldown = 45 * 1000; // 45 seconds in milliseconds
    const now = Date.now();

    if (req.session.lastOtpTime && (now - req.session.lastOtpTime < cooldown)) {
        const remainingSeconds = Math.ceil((cooldown - (now - req.session.lastOtpTime)) / 1000);
        return res.status(429).json({ error: `Please wait ${remainingSeconds}s before resending.` });
    }

    // 1. ROBUST CHECK: Does user exist?
    try {
        const userCheck = await docClient.send(new GetCommand({
            TableName: 'Lakshya_Users',
            Key: { email: email }
        }));
        
        // If user exists, block OTP and tell them to login
        if (userCheck.Item) {
            return res.status(409).json({ error: 'Account already registered. Please Login.' });
        }
    } catch (e) {
        console.error("DB Error checking user:", e);
        return res.status(500).json({ error: 'Server error checking account status.' });
    }

    // 2. Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    req.session.otp = otp;
    
    // Save timestamp for Rate Limiting
    req.session.lastOtpTime = Date.now();
    
    // 3. Email Template
    const htmlContent = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #f4f6f8; padding: 20px;">
  
  <div style="background-color: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 6px 16px rgba(0,0,0,0.08);">
    
    <!-- Header -->
    <div style="background: linear-gradient(135deg, #00d2ff, #3a7bd5); padding: 25px; text-align: center;">
      <img 
        src="https://res.cloudinary.com/dpz44zf0z/image/upload/v1764605760/logo_oeso2m.png"
        alt="LAKSHYA Logo"
        style="height: 60px; margin-bottom: 12px;"
      />
      <h1 style="color: #ffffff; margin: 0; font-size: 26px; letter-spacing: 1px;">
        LAKSHYA 2K26
      </h1>
      <p style="color: #eafaff; margin: 6px 0 0; font-size: 14px;">
        The Annual Techno-Cultural Festival of LBRCE
      </p>
    </div>

    <!-- Body -->
    <div style="padding: 35px; text-align: center;">
      <h2 style="color: #333333; margin-top: 0;">
        Email Verification Code
      </h2>

      <p style="color: #555; font-size: 15px; margin-top: 10px;">
        Thank you for registering for <strong>LAKSHYA 2K26</strong> 🎉  
        Please use the verification code below to complete your registration.
      </p>

      <!-- OTP -->
      <div style="margin: 30px 0;">
        <span style="
          font-size: 32px;
          font-weight: 700;
          letter-spacing: 6px;
          color: #00a8cc;
          background-color: #f0fbff;
          padding: 16px 36px;
          border-radius: 6px;
          border: 2px dashed #00d2ff;
          display: inline-block;
        ">
          ${otp}
        </span>
      </div>

      <p style="color: #666; font-size: 14px;">
        This code is valid for a <strong>limited time</strong>.  
        Please do not share it with anyone for security reasons.
      </p>

      <p style="color: #777; font-size: 13px; margin-top: 25px;">
        If you did not initiate this request, you may safely ignore this email.
      </p>
    </div>

    <!-- Footer -->
    <div style="background-color: #f8f9fb; padding: 18px; text-align: center; border-top: 1px solid #eee;">
      <p style="color: #999; font-size: 12px; margin: 0;">
        © LAKSHYA 2K26 · Lakireddy Bali Reddy College of Engineering  
      </p>
      <p style="color: #999; font-size: 12px; margin: 4px 0 0;">
        This is an automated email. Please do not reply.
      </p>
    </div>

  </div>
</div>
`;

    // 4. Send Email
    try {
        await sendEmail(email, "LAKSHYA 2K26 - Email Verification", htmlContent);
        res.json({ message: 'OTP sent', debug_otp: otp }); 
    } catch (e) {
        console.error("OTP Error:", e);
        // Reset timestamp if sending failed so they can try again immediately
        req.session.lastOtpTime = null; 
        res.status(500).json({ error: 'Failed to send OTP' });
    }
});

// --- 9. API ROUTES: MOCKED PAYMENT & REGISTRATION ---
app.post('/api/register-event', isAuthenticated('participant'), async (req, res) => {
    const { eventId, deptName, paymentMode, teamName, teamMembers, submissionTitle, submissionAbstract, submissionUrl } = req.body;
    const user = req.session.user;

    // CHECK: IS REGISTRATION OPEN FOR THIS DEPT?
    try {
        const statusId = `${eventId}#${deptName}`;
        const statusRes = await docClient.send(new GetCommand({
            TableName: 'Lakshya_EventStatus',
            Key: { statusId }
        }));
        if (statusRes.Item && statusRes.Item.isOpen === false) {
            return res.status(403).json({ error: `Registrations for this event are currently closed by the ${deptName} department.` });
        }
    } catch (e) { console.warn("Status check skipped"); }

    try {
        const checkParams = {
            TableName: 'Lakshya_Registrations',
            IndexName: 'StudentIndex',
            KeyConditionExpression: 'studentEmail = :email',
            FilterExpression: 'eventId = :eid AND deptName = :dept',
            ExpressionAttributeValues: { ':email': user.email, ':eid': eventId, ':dept': deptName }
        };
        const existing = await docClient.send(new QueryCommand(checkParams));
        
        if (existing.Items && existing.Items.length > 0) {
            const existingReg = existing.Items[0];
            
            // IF PAID: Block the request
            if (existingReg.paymentStatus === 'COMPLETED') {
                return res.status(400).json({ error: `You are already registered for this event in the ${deptName} department.` });
            }

            // IF PENDING: Update the existing record with new details
            try {
                await docClient.send(new UpdateCommand({
                    TableName: 'Lakshya_Registrations',
                    Key: { registrationId: existingReg.registrationId },
                    UpdateExpression: "set teamName = :tn, teamMembers = :tm, submissionTitle = :st, submissionAbstract = :sa, submissionUrl = :su, paymentMode = :pm, registeredAt = :now",
                    ExpressionAttributeValues: {
                        ':tn': teamName || null,
                        ':tm': teamMembers || [],
                        ':st': submissionTitle || null,
                        ':sa': submissionAbstract || null,
                        ':su': submissionUrl || null,
                        ':pm': paymentMode,
                        ':now': new Date().toISOString()
                    }
                }));
                return res.json({ message: 'Registration updated', registrationId: existingReg.registrationId });
            } catch (updateErr) {
                console.error(updateErr);
                return res.status(500).json({ error: 'Failed to update pending registration.' });
            }
        }
    } catch (e) {
        return res.status(500).json({ error: 'Server validation failed' });
    }

    // --- UPDATED LOGIC START ---
    // Get Event Title AND Type to determine Kit Eligibility
    let eventTitle = eventId; 
    let eventType = '';
    
    try {
        const eventRes = await docClient.send(new GetCommand({ TableName: 'Lakshya_Events', Key: { eventId } }));
        if (eventRes.Item) {
            eventTitle = eventRes.Item.title;
            eventType = eventRes.Item.type || '';
        }
    } catch (e) {}

    // Calculate Kit Eligibility using the helper
    const isKitEligible = checkKitEligibility(eventType);
    // --- UPDATED LOGIC END ---

    const registrationId = uuidv4();
    const paymentStatus = 'PENDING'; 

    const params = {
        TableName: 'Lakshya_Registrations',
        Item: {
            registrationId,
            studentEmail: user.email,
            eventId,
            deptName,
            category: eventType, // Save Category for stats
            kitAllocated: isKitEligible, // Save Kit Status permanently
            teamName: teamName || null, 
            teamMembers: teamMembers || [],
            submissionTitle: submissionTitle || null,
            submissionAbstract: submissionAbstract || null,
            submissionUrl: submissionUrl || null,
            paymentStatus: paymentStatus,
            paymentMode, 
            attendance: false,
            registeredAt: new Date().toISOString()
        }
    };

    try {
        await docClient.send(new PutCommand(params));
        
        // Send Email if Pay at Venue
        if (paymentMode !== 'Online') {
            const logoUrl = "https://res.cloudinary.com/dpz44zf0z/image/upload/v1764605760/logo_oeso2m.png";
            const emailHtml = `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; padding: 20px; background-color: #fff; max-width: 600px; margin: 0 auto; border: 1px solid #eee;">
                <div style="text-align: center; margin-bottom: 10px;">
                    <img src="${logoUrl}" alt="Lakshya Logo" style="height: 60px; width: auto;">
                </div>
                <h2 style="color: #4fc3f7; margin-bottom: 20px; font-weight: bold; text-align: center; font-size: 26px;">LAKSHYA 2K26</h2>
                <p style="font-size: 15px; color: #333;">Dear Participant,</p>
                <p style="font-size: 15px; color: #333;">Thank you for registering for <strong>${eventTitle}</strong>. Below are your registration details:</p>
                <div style="background-color: #f9f9f9; padding: 25px; border-radius: 4px; margin: 25px 0;">
                    <p style="margin: 8px 0; color: #333;"><strong>Registration ID:</strong> ${registrationId}</p>
                    <p style="margin: 8px 0; color: #333;"><strong>Event:</strong> ${eventTitle}</p>
                    ${isKitEligible ? `<p style="margin: 8px 0; color: #e91e63;"><strong>Note:</strong> This registration includes a <strong>Free Kit</strong> (collect at venue).</p>` : ''}
                    <p style="margin: 8px 0; color: #333;"><strong>Payment Status:</strong> <strong style="color: #ff9800;">Payment Pending (Pay at Venue)</strong></p>
                </div>
                <p style="margin-top: 30px; color: #333;">Best Regards,<br>Team LAKSHYA</p>
            </div>`;
            
            await sendEmail(user.email, `Registration Details: ${eventTitle}`, emailHtml);

            if (teamMembers && Array.isArray(teamMembers)) {
                teamMembers.filter(m => m.email).forEach(m => sendEmail(m.email, `Registration Details: ${eventTitle}`, emailHtml));
            }
        }

        res.json({ message: 'Registration initiated', registrationId });
    } catch (err) {
        res.status(500).json({ error: 'Registration failed' });
    }
});
// Create Order (Razorpay)
app.post('/api/payment/create-order', isAuthenticated('participant'), async (req, res) => {
    try {
        const { cartItems, couponCode } = req.body;
        
        // 1. Fetch real event data
        let events = [];
        for (const item of cartItems) {
            const eventDoc = await docClient.send(new GetCommand({ TableName: 'Lakshya_Events', Key: { eventId: item.eventId } }));
            if (eventDoc.Item) {
                events.push({ ...eventDoc.Item, fee: parseInt(eventDoc.Item.fee) });
            }
        }

        // 2. Sort events by fee (High to Low)
        events.sort((a, b) => b.fee - a.fee);

        let totalAmount = 0;
        
        // Fetch Standard Coupon
        let standardCoupon = null;
        if (couponCode && couponCode !== 'LAKSHYA2K26') {
            const couponQuery = await docClient.send(new GetCommand({ TableName: 'Lakshya_Coupons', Key: { code: couponCode.toUpperCase() } }));
            if (couponQuery.Item && couponQuery.Item.currentUses < couponQuery.Item.usageLimit) {
                standardCoupon = couponQuery.Item;
            }
        }

        // 3. HISTORY CHECK (Combo Logic)
        let historyCount = 0;
        if (couponCode === 'LAKSHYA2K26' && req.session.user && req.session.user.email) {
            try {
                const existingRegs = await docClient.send(new QueryCommand({
                    TableName: 'Lakshya_Registrations',
                    IndexName: 'StudentIndex',
                    KeyConditionExpression: 'studentEmail = :email',
                    ExpressionAttributeValues: { ':email': req.session.user.email }
                }));
                const regs = existingRegs.Items || [];
                
                for (const reg of regs) {
                    if (reg.paymentStatus === 'COMPLETED') {
                        const isInCart = events.some(e => String(e.eventId).trim() === String(reg.eventId).trim());
                        if (!isInCart) {
                             if(reg.amountPaid) historyCount++; 
                        }
                    }
                }
            } catch (e) { console.error("History check error:", e); }
        }

        // 4. CALCULATE PRICES
        let currentEligibleIndex = 0; 
        const itemAmounts = {}; // We still calculate this for internal logic

        for (const event of events) {
            let finalItemPrice = event.fee;
            const isEligible = isEligibleForCombo(event);

            if (couponCode === 'LAKSHYA2K26' && isEligible) {
                currentEligibleIndex++;
                const effectivePosition = historyCount + currentEligibleIndex;
                if (effectivePosition > 1) {
                    finalItemPrice = event.fee / 2; // 50% OFF
                }
            } 
            else if (standardCoupon) {
                const type = (event.type || '').toLowerCase();
                if (!type.includes('special') && standardCoupon.allowedTypes && standardCoupon.allowedTypes.includes(event.type)) {
                    finalItemPrice = event.fee - (event.fee * standardCoupon.percentage / 100);
                }
            }

            itemAmounts[event.eventId] = finalItemPrice;
            totalAmount += finalItemPrice;
        }

        // 5. Platform Fee & Rounding
        const platformFee = Math.ceil(totalAmount * 0.0236);
        const finalTotal = totalAmount + platformFee;
        const amountInPaise = Math.round(finalTotal * 100); 

        // 6. Create Payment Link
        const CALLBACK_URL = "http://localhost:3000/participant/payment-success"; 

        const paymentLink = await razorpay.paymentLink.create({
            amount: amountInPaise, 
            currency: "INR",
            accept_partial: false,
            description: "LAKSHYA 2K26 Registration",
            customer: {
                name: req.session.user.name || "Student",
                email: req.session.user.email,
                contact: req.session.user.mobile || "+919000000000"
            },
            // FIX 1: DISABLE RAZORPAY EMAIL
            notify: { 
                sms: true, 
                email: false 
            },
            reminder_enable: false,
            callback_url: CALLBACK_URL,
            callback_method: "get"
        });

        res.json({
            paymentLink: paymentLink.short_url,
            paymentLinkId: paymentLink.id,
            itemAmounts: itemAmounts 
        });

    } catch (error) {
        console.error("Order Creation Error:", error);
        res.status(500).json({ error: "Failed to create order." });
    }
});

app.post('/api/payment/verify', isAuthenticated('participant'), async (req, res) => {
    // 1. EXTRACT DATA
    let { razorpay_payment_id, couponCode, cartItems, pendingRegIds } = req.body; 
    const CLIENT_URL = "http://localhost:3000"; 
    const logoUrl = "https://res.cloudinary.com/dpz44zf0z/image/upload/v1764605760/logo_oeso2m.png";
    const user = req.session.user;

    try {
        if (!razorpay_payment_id) return res.status(400).json({ error: 'Missing Payment ID' });

        // 2. VERIFY WITH RAZORPAY (Server-to-Server check)
        const payment = await razorpay.payments.fetch(razorpay_payment_id);
        if (payment.status !== 'captured' && payment.status !== 'authorized') {
            return res.status(400).json({ error: 'Payment not captured or failed.' });
        }

        // 3. IDEMPOTENCY CHECK (Prevents duplicate registrations if student refreshes)
        const existing = await docClient.send(new ScanCommand({
            TableName: 'Lakshya_Registrations',
            FilterExpression: 'paymentId = :pid',
            ExpressionAttributeValues: { ':pid': razorpay_payment_id }
        }));
        if (existing.Items && existing.Items.length > 0) {
            return res.json({ status: 'success', message: 'Already processed' });
        }

        // 4. THE CRITICAL FIX: ROBUST CART RECOVERY
        // If frontend sent empty cart (common mobile browser bug), pull from server-side Lakshya_Cart table
        if (!pendingRegIds && (!cartItems || cartItems.length === 0)) {
            try {
                const dbCart = await docClient.send(new GetCommand({ 
                    TableName: 'Lakshya_Cart', 
                    Key: { email: user.email } 
                }));
                if (dbCart.Item && dbCart.Item.items) {
                    cartItems = dbCart.Item.items;
                }
            } catch (cartErr) {
                console.error("Cart Recovery Failed:", cartErr);
            }
        }

        let eventsToProcess = [];

        // A. If Processing Pending Registrations (from My Registrations page)
        if (pendingRegIds && Array.isArray(pendingRegIds) && pendingRegIds.length > 0) {
            for (const regId of pendingRegIds) {
                const regDoc = await docClient.send(new GetCommand({ TableName: 'Lakshya_Registrations', Key: { registrationId: regId }}));
                if (regDoc.Item) {
                    const eventDoc = await docClient.send(new GetCommand({ TableName: 'Lakshya_Events', Key: { eventId: regDoc.Item.eventId }}));
                    if(eventDoc.Item) {
                        eventsToProcess.push({
                            ...eventDoc.Item, 
                            fee: parseInt(eventDoc.Item.fee),
                            source: 'PENDING',
                            regId: regId,
                            dept: regDoc.Item.deptName,
                            teamName: regDoc.Item.teamName
                        });
                    }
                }
            }
        } 
        // B. If Processing New Cart Items (from Cart page)
        else if (cartItems && Array.isArray(cartItems) && cartItems.length > 0) {
            for (const item of cartItems) {
                const eventDoc = await docClient.send(new GetCommand({ TableName: 'Lakshya_Events', Key: { eventId: item.eventId } }));
                if (eventDoc.Item) {
                    eventsToProcess.push({ 
                        ...eventDoc.Item, 
                        fee: parseInt(eventDoc.Item.fee),
                        source: 'NEW_CART',
                        dept: item.dept,
                        teamName: item.teamName,
                        teamMembers: item.teamMembers,
                        submissionTitle: item.submissionTitle,
                        submissionAbstract: item.submissionAbstract,
                        submissionUrl: item.submissionUrl
                    });
                }
            }
        }

        // If after recovery attempt it's still empty, stop here.
        if (eventsToProcess.length === 0) return res.json({ status: 'success', warning: 'No Items Found' }); 

        // 5. SERVER-SIDE RE-CALCULATION (Pricing Logic)
        eventsToProcess.sort((a, b) => b.fee - a.fee);

        let standardCoupon = null;
        if (couponCode && couponCode !== 'LAKSHYA2K26' && couponCode !== 'NONE') {
            const couponQuery = await docClient.send(new GetCommand({ TableName: 'Lakshya_Coupons', Key: { code: couponCode.toUpperCase() } }));
            if (couponQuery.Item && couponQuery.Item.currentUses < couponQuery.Item.usageLimit) {
                standardCoupon = couponQuery.Item;
            }
        }

        let historyCount = 0;
        if (couponCode === 'LAKSHYA2K26') {
            try {
                const existingRegs = await docClient.send(new QueryCommand({
                    TableName: 'Lakshya_Registrations',
                    IndexName: 'StudentIndex',
                    KeyConditionExpression: 'studentEmail = :email',
                    ExpressionAttributeValues: { ':email': user.email }
                }));
                const regs = existingRegs.Items || [];
                for (const reg of regs) {
                    if (reg.paymentStatus === 'COMPLETED' && !eventsToProcess.some(e => e.eventId === reg.eventId)) {
                        if (reg.category) {
                            if (isEligibleForCombo({ type: reg.category, title: '', fee: 100 })) historyCount++; 
                        } else if(reg.amountPaid) {
                            historyCount++; 
                        }
                    }
                }
            } catch (e) { console.error("History check error:", e); }
        }

        let currentEligibleIndex = 0;
        const calculatedAmounts = {};

        for (const event of eventsToProcess) {
            let finalItemPrice = event.fee;
            const isEligible = isEligibleForCombo(event);

            if (couponCode === 'LAKSHYA2K26' && isEligible) {
                currentEligibleIndex++;
                if (historyCount + currentEligibleIndex > 1) {
                    finalItemPrice = event.fee / 2;
                }
            } 
            else if (standardCoupon) {
                const type = (event.type || '').toLowerCase();
                if (!type.includes('special') && standardCoupon.allowedTypes?.includes(event.type)) {
                    finalItemPrice = event.fee - (event.fee * standardCoupon.percentage / 100);
                }
            }
            calculatedAmounts[event.eventId] = finalItemPrice;
        }

        // 6. DATABASE UPDATES (Save Registrations)
        let regItemsForEmail = [];
        let totalBaseForEmail = 0;

        const processPromises = eventsToProcess.map(async (event) => {
            const finalAmount = calculatedAmounts[event.eventId];
            
            if (event.source === 'PENDING') {
                await docClient.send(new UpdateCommand({
                    TableName: 'Lakshya_Registrations',
                    Key: { registrationId: event.regId },
                    UpdateExpression: "set paymentStatus = :s, paymentId = :pid, paymentMode = :pm, couponUsed = :cu, paymentDate = :pd, amountPaid = :ap",
                    ExpressionAttributeValues: {
                        ":s": "COMPLETED",
                        ":pid": razorpay_payment_id,
                        ":pm": "ONLINE",
                        ":cu": couponCode || "NONE",
                        ":pd": new Date().toISOString(),
                        ":ap": finalAmount
                    }
                }));
                regItemsForEmail.push({ regId: event.regId, title: event.title, dept: event.dept, paidAmount: finalAmount, teamName: event.teamName });
            } 
            else {
                const regId = uuidv4();
                await docClient.send(new PutCommand({
                    TableName: 'Lakshya_Registrations', 
                    Item: {
                        registrationId: regId,
                        studentEmail: user.email,
                        eventId: event.eventId,
                        deptName: event.dept,
                        category: event.type,
                        kitAllocated: checkKitEligibility(event.type),
                        teamName: event.teamName || null,
                        teamMembers: event.teamMembers || [],
                        paymentStatus: "COMPLETED", 
                        paymentId: razorpay_payment_id, 
                        paymentMode: "ONLINE", 
                        attendance: false,
                        couponUsed: couponCode || "NONE", 
                        paymentDate: new Date().toISOString(), 
                        amountPaid: finalAmount,
                        registeredAt: new Date().toISOString(),
                        submissionTitle: event.submissionTitle || null,
                        submissionAbstract: event.submissionAbstract || null,
                        submissionUrl: event.submissionUrl || null
                    }
                }));
                regItemsForEmail.push({ regId: regId, title: event.title, dept: event.dept, paidAmount: finalAmount, teamName: event.teamName });
            }
            totalBaseForEmail += finalAmount;
        });

        await Promise.all(processPromises);

        // 7. CLEAR CART & FETCH USER NAME
        try { await docClient.send(new DeleteCommand({ TableName: 'Lakshya_Cart', Key: { email: user.email } })); } catch(e) {}
        
        let userName = user.name || "Participant";
        try {
            const u = await docClient.send(new GetCommand({ TableName: 'Lakshya_Users', Key: { email: user.email }}));
            if(u.Item) userName = u.Item.fullName;
        } catch(e) {}

        // 8. SEND EMAILS (Original Templates Restored)
        if (regItemsForEmail.length > 0) {
            const totalPaid = payment.amount / 100;
            const platformFee = totalPaid - totalBaseForEmail; 

            // Template 1: Registration Confirmed
            const eventsHtml = regItemsForEmail.map(item => `
                <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin-bottom: 15px; border-left: 4px solid #00d2ff;">
                    <p style="margin: 5px 0;"><strong>Event:</strong> ${item.title}</p>
                    <p style="margin: 5px 0;"><strong>Reg ID:</strong> ${item.regId}</p>
                    <p style="margin: 5px 0;"><strong>Dept:</strong> ${item.dept}</p>
                    ${item.teamName ? `<p style="margin: 5px 0;"><strong>Team:</strong> ${item.teamName}</p>` : ''}
                    <div style="margin-top: 15px;">
                        <a href="${CLIENT_URL}receipt-view?id=${item.regId}" style="display: inline-block; background-color: #00d2ff; color: white; padding: 10px 15px; text-decoration: none; border-radius: 4px; font-weight: bold; font-size: 14px;">View Ticket</a>
                    </div>
                </div>`).join('');

            const regEmailHtml = `
                <div style="font-family: 'Segoe UI', sans-serif; padding: 20px; border: 1px solid #eee; max-width: 600px; margin: 0 auto;">
                    <div style="text-align: center; margin-bottom: 20px;">
                        <img src="${logoUrl}" style="height: 50px;">
                        <h2 style="color: #4fc3f7; margin: 10px 0;">Registration Confirmed</h2>
                    </div>
                    <p>Dear ${userName},</p>
                    <p>Thank you for registering!</p>
                    ${eventsHtml}
                    <p style="color: #4CAF50; font-weight: bold;">Status: Payment Successful</p>
                    <p style="color: #555; font-size: 14px; margin-top: 30px;">Best Regards,<br>Team LAKSHYA</p>
                </div>`;
            
            // Template 2: Receipt
            const paymentRows = regItemsForEmail.map(item => `
                <tr>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${item.title}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right;">₹${item.paidAmount.toFixed(2)}</td>
                </tr>`).join('');
            
            const receiptHtml = `
                <div style="font-family: 'Segoe UI', sans-serif; border: 1px solid #eee; max-width: 600px; margin: 0 auto; border-radius: 8px; overflow: hidden;">
                    <div style="background-color: #00d2ff; padding: 20px; text-align: center; color: white;">
                        <img src="${logoUrl}" style="height: 40px; margin-bottom: 10px; background: rgba(255,255,255,0.2); padding: 5px; border-radius: 5px;">
                        <h2 style="margin: 0;">PAYMENT RECEIPT</h2>
                    </div>
                    <div style="padding: 20px;">
                        <p>Dear ${userName},</p>
                        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                            <tr style="background-color: #f5f5f5;">
                                <th style="padding: 10px; text-align: left;">Event</th>
                                <th style="padding: 10px; text-align: right;">Amount</th>
                            </tr>
                            ${paymentRows}
                            <tr><td style="padding: 8px; color: #888;">Platform Fee</td><td style="padding: 8px; text-align: right; color: #888;">₹${platformFee.toFixed(2)}</td></tr>
                            <tr><td style="padding: 10px; font-weight: bold;">Total Paid</td><td style="padding: 10px; font-weight: bold; text-align: right;">₹${totalPaid.toFixed(2)}</td></tr>
                        </table>
                        <div style="background-color: #f9f9f9; padding: 15px; border-left: 4px solid #4CAF50;">
                            <p style="margin: 5px 0; font-size: 13px;"><strong>Transaction ID:</strong> ${razorpay_payment_id}</p>
                        </div>
                    </div>
                </div>`;

            // Parallel Send for efficiency
            await Promise.all([
                sendEmail(user.email, `Registration Confirmed`, regEmailHtml),
                sendEmail(user.email, `Payment Receipt - Transaction ${razorpay_payment_id}`, receiptHtml)
            ]);
        }

        res.json({ status: 'success' }); 

    } catch (err) {
        console.error("Verify Error:", err);
        res.status(500).json({ error: 'Verification failed.' });
    }
});
app.get('/api/participant/dashboard-stats', isAuthenticated('participant'), async (req, res) => {
    const userEmail = req.session.user.email;
    try {
        const userRes = await docClient.send(new GetCommand({ TableName: 'Lakshya_Users', Key: { email: userEmail } }));
        const userDetails = userRes.Item || {};

        const data = await docClient.send(new QueryCommand({
            TableName: 'Lakshya_Registrations', IndexName: 'StudentIndex',
            KeyConditionExpression: 'studentEmail = :email',
            ExpressionAttributeValues: { ':email': userEmail }
        }));
        
        const registrations = data.Items || [];
        const total = registrations.length;
        const paid = registrations.filter(r => r.paymentStatus === 'COMPLETED').length;
        
        // --- UPDATED KIT COUNT LOGIC ---
        // Count if Payment is COMPLETED AND (kitAllocated is true OR check category as fallback)
        let kitsOwned = 0;
        registrations.forEach(r => {
            if (r.paymentStatus === 'COMPLETED') {
                if (r.kitAllocated === true) {
                    kitsOwned++;
                } else if (checkKitEligibility(r.category)) {
                    // Fallback for old data or if category was saved but flag wasn't
                    kitsOwned++;
                }
            }
        });

        let status = total > 0 ? (paid === total ? 'Paid' : (paid > 0 ? 'Partial' : 'Pending')) : 'None';

        res.json({
            name: userDetails.fullName || req.session.user.name,
            rollNo: userDetails.rollNo || '-',
            college: userDetails.college || '',
            mobile: userDetails.mobile || '',
            totalRegistrations: total,
            paymentStatus: status,
            kitsOwned: kitsOwned // Display on Dashboard
        });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});
app.get('/api/participant/my-registrations-data', isAuthenticated('participant'), async (req, res) => {
    const userEmail = req.session.user.email;
    try {
        const data = await docClient.send(new QueryCommand({
            TableName: 'Lakshya_Registrations', IndexName: 'StudentIndex',
            KeyConditionExpression: 'studentEmail = :email',
            ExpressionAttributeValues: { ':email': userEmail }
        }));
        res.json(data.Items);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});


// =========================================================
//  --- COORDINATOR API ROUTES (FIXED & CONSOLIDATED) ---
// =========================================================

// 1. Get Dashboard Data (Handles Specific Event Coordinators vs Dept Coordinators)
app.get('/api/coordinator/dashboard-data', isAuthenticated('coordinator'), async (req, res) => {
    try {
        const user = req.session.user;
        const userDept = user.dept;
        const managedEventIds = user.managedEventIds || [];

        // SCENARIO 1: Multi-Event Coordinator
        if (managedEventIds.length > 0) {
            let allRegistrations = [];
            
            // Run a scan for each event ID in parallel
            const promises = managedEventIds.map(eid => 
                docClient.send(new ScanCommand({
                    TableName: 'Lakshya_Registrations',
                    FilterExpression: 'eventId = :eid',
                    ExpressionAttributeValues: { ':eid': eid }
                }))
            );
            
            const results = await Promise.all(promises);
            results.forEach(r => { if(r.Items) allRegistrations.push(...r.Items); });
            
            return res.json({ 
                dept: 'My Managed Events', 
                registrations: allRegistrations 
            });
        }

        // SCENARIO 2: Department Coordinator (Standard Fallback)
        if (!userDept) return res.json({ dept: 'Unknown', registrations: [] });
        
        const params = {
            TableName: 'Lakshya_Registrations',
            IndexName: 'DepartmentIndex',
            KeyConditionExpression: 'deptName = :dept',
            ExpressionAttributeValues: { ':dept': userDept }
        };
        const data = await docClient.send(new QueryCommand(params));
        res.json({ dept: userDept, registrations: data.Items || [] });

    } catch (err) {
        console.error("Coord Dashboard Error:", err);
        res.status(500).json({ error: 'Failed to load data' });
    }
});
// 2. Get Events List (My Events)
app.get('/api/coordinator/my-events', isAuthenticated('coordinator'), async (req, res) => {
    const user = req.session.user;
    const managedEventIds = user.managedEventIds || [];

    // SCENARIO 1: Specific List (Cultural/Special Coordinators)
    if (managedEventIds.length > 0) {
        try {
            const promises = managedEventIds.map(eid => 
                docClient.send(new GetCommand({ 
                    TableName: 'Lakshya_Events', 
                    Key: { eventId: eid } 
                }))
            );
            const results = await Promise.all(promises);
            const myEvents = results.map(r => r.Item).filter(i => i); 
            return res.json(myEvents);
        } catch(e) { return res.json([]); }
    }

    // SCENARIO 2: Normal Dept Coordinators
    const userDept = user.dept;
    if (!userDept) return res.json([]);

    try {
        const data = await docClient.send(new ScanCommand({ TableName: 'Lakshya_Events' }));
        const allEvents = data.Items || [];
        
        const myEvents = allEvents.filter(e => {
            // 1. Basic Check: Is this event open to my department?
            const isRelevant = e.departments && e.departments.includes(userDept);
            if (!isRelevant) return false;

            // 2. STRICT FILTER: Hide ONLY Cultural events
            // We REMOVED 'major' from here so Dept Coords can see their Major events
            const type = (e.type || '').toLowerCase();
            const title = (e.title || '').toLowerCase();
            
            // Only hide these specific cultural categories
            const culturalKeywords = ['cultural', 'music', 'dance', 'drama', 'fashion', 'singing', 'art', 'literary'];
            
            if (userDept !== 'CULTURAL') {
                if (culturalKeywords.some(k => type.includes(k) || title.includes(k))) {
                    return false;
                }
            }

            return true;
        });

        res.json(myEvents);
    } catch(e) { res.status(500).json({ error: 'Failed' }); }
});
// 3. Get Students for Attendance (FIXED for Specific Event Coordinators)
app.get('/api/coordinator/event-students', isAuthenticated('coordinator'), async (req, res) => {
    const { eventId } = req.query;
    const user = req.session.user;
    const managedEventIds = user.managedEventIds || [];

    try {
        let items = [];

        // SCENARIO 1: Multi-Event Coordinator
        if (managedEventIds.length > 0) {
            // Security: Ensure they are asking for one of THEIR events
            if(eventId && !managedEventIds.includes(eventId)) {
                 return res.json([]); 
            }
            
            // If eventId provided, fetch for that one. If not, fetch for ALL managed.
            const idsToFetch = eventId ? [eventId] : managedEventIds;

            const promises = idsToFetch.map(eid => 
                docClient.send(new ScanCommand({
                    TableName: 'Lakshya_Registrations',
                    FilterExpression: 'eventId = :eid AND paymentStatus = :paid',
                    ExpressionAttributeValues: { ':eid': eid, ':paid': 'COMPLETED' }
                }))
            );
            
            const results = await Promise.all(promises);
            results.forEach(r => { if(r.Items) items.push(...r.Items); });
        } 
        // SCENARIO 2: Dept Coordinator
        else {
            const params = {
                TableName: 'Lakshya_Registrations',
                IndexName: 'DepartmentIndex',
                KeyConditionExpression: 'deptName = :dept',
                FilterExpression: 'eventId = :eid AND paymentStatus = :paid',
                ExpressionAttributeValues: {
                    ':dept': user.dept,
                    ':eid': eventId,
                    ':paid': 'COMPLETED'
                }
            };
            const data = await docClient.send(new QueryCommand(params));
            items = data.Items || [];
        }

        res.json(items);
    } catch(e) {
        res.status(500).json({ error: 'Failed to fetch students' });
    }
});
// 4. Pending Payments (FIXED for Specific Event Coordinators)
app.get('/api/coordinator/pending-payments', isAuthenticated('coordinator'), async (req, res) => {
    try {
        const user = req.session.user;
        const managedEventIds = user.managedEventIds || [];
        let items = [];

        if (managedEventIds.length > 0) {
            const promises = managedEventIds.map(eid => 
                docClient.send(new ScanCommand({
                    TableName: 'Lakshya_Registrations',
                    FilterExpression: 'eventId = :eid AND paymentStatus <> :paid',
                    ExpressionAttributeValues: { ':eid': eid, ':paid': 'COMPLETED' }
                }))
            );
            const results = await Promise.all(promises);
            results.forEach(r => { if(r.Items) items.push(...r.Items); });
        } else {
            const params = {
                TableName: 'Lakshya_Registrations',
                IndexName: 'DepartmentIndex',
                KeyConditionExpression: 'deptName = :dept',
                FilterExpression: 'paymentStatus <> :paid',
                ExpressionAttributeValues: { ':dept': user.dept, ':paid': 'COMPLETED' }
            };
            const data = await docClient.send(new QueryCommand(params));
            items = data.Items || [];
        }

        res.json(items);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch data' });
    }
});
// 5. Quick Attendance (Lookup)
app.post('/api/coordinator/quick-attendance', isAuthenticated('coordinator'), async (req, res) => {
    const { identifier } = req.body; // This is the Registration ID from QR Code
    const user = req.session.user;
    const managedEventIds = user.managedEventIds || [];

    try {
        // STEP 1: Fetch the registration first to check permission
        const getParams = {
            TableName: 'Lakshya_Registrations',
            Key: { registrationId: identifier }
        };
        const getResult = await docClient.send(new GetCommand(getParams));
        const reg = getResult.Item;

        if (!reg) {
            return res.status(404).json({ error: 'Invalid QR Code' });
        }

        // STEP 2: Verify Coordinator Permission
        // If coordinator has a specific list, the student's event MUST be in that list
        if (managedEventIds.length > 0 && !managedEventIds.includes(reg.eventId)) {
            return res.status(403).json({ error: 'Student does not belong to your managed events.' });
        }
        
        // Also check if Dept Coordinator (fallback) matches department
        if (managedEventIds.length === 0 && user.dept && reg.deptName !== user.dept) {
             return res.status(403).json({ error: 'Student belongs to a different department.' });
        }

        // STEP 3: Mark Present
        const updateParams = {
            TableName: 'Lakshya_Registrations',
            Key: { registrationId: identifier },
            UpdateExpression: "set attendance = :a",
            ExpressionAttributeValues: { ":a": true },
            ReturnValues: "ALL_NEW"
        };

        const data = await docClient.send(new UpdateCommand(updateParams));
        
        res.json({ 
            message: 'Success', 
            studentEmail: data.Attributes.studentEmail, 
            eventId: data.Attributes.eventId,
            studentName: data.Attributes.teamName || 'Student' // useful for frontend display
        });

    } catch (err) { 
        console.error("Quick Attendance Error:", err);
        res.status(500).json({ error: 'Lookup failed' }); 
    }
});
// 6. Mark Attendance
app.post('/api/coordinator/mark-attendance', isAuthenticated('coordinator'), async (req, res) => {
    const { registrationId, status } = req.body;
    
    // Optional: Add security check here similar to above if you want strict security
    // For now, we update strictly by ID which is generally safe for manual toggles
    
    const params = {
        TableName: 'Lakshya_Registrations', 
        Key: { registrationId },
        UpdateExpression: "set attendance = :a", 
        ExpressionAttributeValues: { ":a": status }
    };
    
    try { 
        await docClient.send(new UpdateCommand(params)); 
        res.json({ message: 'Attendance updated' }); 
    }
    catch (err) { 
        res.status(500).json({ error: 'Update failed' }); 
    }
});
// 7. Mark Paid
app.post('/api/coordinator/mark-paid', isAuthenticated('coordinator'), async (req, res) => {
    const { registrationId } = req.body;
    const params = {
        TableName: 'Lakshya_Registrations', Key: { registrationId },
        UpdateExpression: "set paymentStatus = :s, paymentMode = :m",
        ExpressionAttributeValues: { ":s": "COMPLETED", ":m": "CASH" }
    };
    try { await docClient.send(new UpdateCommand(params)); res.json({ message: 'Payment marked as received' }); }
    catch (err) { res.status(500).json({ error: 'Update failed' }); }
});

// 8. Fetch Student Details (No changes needed)
app.get('/api/coordinator/student-details', isAuthenticated('coordinator'), async (req, res) => {
    const { email } = req.query;
    try {
        const data = await docClient.send(new GetCommand({ TableName: 'Lakshya_Users', Key: { email } }));
        if (data.Item) {
            const { password, ...studentData } = data.Item;
            res.json(studentData);
        } else { res.status(404).json({ error: 'Student not found' }); }
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// 9. Export Bulk Data
app.post('/api/coordinator/export-data', isAuthenticated('coordinator'), async (req, res) => {
    const { emails } = req.body; 
    if (!emails || !Array.isArray(emails) || emails.length === 0) return res.json({});
    const uniqueEmails = [...new Set(emails)];

    try {
        const userPromises = uniqueEmails.map(email => 
            docClient.send(new GetCommand({
                TableName: 'Lakshya_Users', Key: { email },
                ProjectionExpression: 'email, fullName, rollNo, dept, mobile, #y, college',
                ExpressionAttributeNames: { "#y": "year" } 
            }))
        );
        const results = await Promise.all(userPromises);
        const userMap = {};
        results.forEach(r => { if (r.Item) userMap[r.Item.email] = r.Item; });
        res.json(userMap);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// 10. Scoring Details
app.get('/api/coordinator/scoring-details', isAuthenticated('coordinator'), async (req, res) => {
    const { eventId } = req.query;
    const user = req.session.user;
    const managedEventIds = user.managedEventIds || [];
    
    // Validate request
    if (!eventId) return res.status(400).json({ error: "Missing eventId" });
    if (managedEventIds.length > 0 && !managedEventIds.includes(eventId)) {
        return res.status(403).json({ error: "Unauthorized for this event" });
    }

    try {
        // Fetch Scheme (Scheme ID is typically eventId#DeptName)
        // Since this coord manages specific events, we try to construct ID using the user's dept (e.g., CULTURAL)
        const deptName = user.dept || "General"; 
        const schemeId = `${eventId}#${deptName}`;
        
        const schemeRes = await docClient.send(new GetCommand({
            TableName: 'Lakshya_ScoringSchemes', Key: { schemeId }
        }));
        const scheme = schemeRes.Item;
        if (!scheme) return res.json({ enabled: false, message: "Scoring not configured." });

        // Fetch Students (Present only)
        // We use Scan here because we know exactly which eventId we are looking for
        const params = {
            TableName: 'Lakshya_Registrations',
            FilterExpression: 'eventId = :eid AND attendance = :att',
            ExpressionAttributeValues: { ':eid': eventId, ':att': true }
        };
        const data = await docClient.send(new ScanCommand(params));
        const students = data.Items || [];

        res.json({
            enabled: true,
            scheme: scheme.criteria,
            isLocked: scheme.isLocked === true,
            students: students.map(s => ({
                registrationId: s.registrationId,
                studentEmail: s.studentEmail,
                totalScore: s.totalScore || 0,
                scoreBreakdown: s.scoreBreakdown || {}, 
                teamName: s.teamName
            }))
        });
    } catch (err) { res.status(500).json({ error: "Failed to load scoring data" }); }
});
// 11. Submit Scores
app.post('/api/coordinator/submit-scores', isAuthenticated('coordinator'), async (req, res) => {
    const { eventId, scores, finalize } = req.body; 
    const deptName = req.session.user.dept || "General"; 

    try {
        const updatePromises = scores.map(student => {
            return docClient.send(new UpdateCommand({
                TableName: 'Lakshya_Registrations',
                Key: { registrationId: student.registrationId },
                UpdateExpression: "set scoreBreakdown = :sb, totalScore = :ts",
                ExpressionAttributeValues: { ":sb": student.breakdown, ":ts": student.total }
            }));
        });
        await Promise.all(updatePromises);

        if (finalize) {
            const schemeId = `${eventId}#${deptName}`;
            await docClient.send(new UpdateCommand({
                TableName: 'Lakshya_ScoringSchemes', Key: { schemeId },
                UpdateExpression: "set isLocked = :l", ExpressionAttributeValues: { ":l": true }
            }));
        }
        res.json({ message: finalize ? "Locked" : "Saved" });
    } catch (err) { res.status(500).json({ error: "Failed" }); }
});

// 12. View Submissions
app.get('/api/coordinator/submissions', isAuthenticated('coordinator'), async (req, res) => {
    const user = req.session.user;
    const managedEventIds = user.managedEventIds || [];

    try {
        let items = [];
        if (managedEventIds.length > 0) {
            const promises = managedEventIds.map(eid => 
                docClient.send(new ScanCommand({
                    TableName: 'Lakshya_Registrations',
                    FilterExpression: 'eventId = :eid',
                    ExpressionAttributeValues: { ':eid': eid }
                }))
            );
            const results = await Promise.all(promises);
            results.forEach(r => { if(r.Items) items.push(...r.Items); });
        } else {
            const params = {
                TableName: 'Lakshya_Registrations',
                IndexName: 'DepartmentIndex',
                KeyConditionExpression: 'deptName = :dept',
                ExpressionAttributeValues: { ':dept': user.dept }
            };
            const data = await docClient.send(new QueryCommand(params));
            items = data.Items || [];
        }
        
        const withSubs = items.filter(r => r.submissionTitle || r.submissionUrl);
        // Sort by Date
        withSubs.sort((a, b) => new Date(b.registeredAt) - new Date(a.registeredAt));
        res.json(withSubs);
    } catch (err) { res.status(500).json({ error: "Failed" }); }
});
// 13. Event Control
app.get('/api/coordinator/event-controls', isAuthenticated('coordinator'), async (req, res) => {
    const user = req.session.user;
    const managedEventIds = user.managedEventIds || [];

    try {
        let myEvents = [];

        // SCENARIO 1: Multi-Event Coordinator
        if (managedEventIds.length > 0) {
            const promises = managedEventIds.map(eid => 
                docClient.send(new GetCommand({ TableName: 'Lakshya_Events', Key: { eventId: eid }}))
            );
            const results = await Promise.all(promises);
            myEvents = results.map(r => r.Item).filter(i => i);
        } 
        // SCENARIO 2: Department Coordinator
        else {
             const eventData = await docClient.send(new ScanCommand({ TableName: 'Lakshya_Events' }));
             myEvents = (eventData.Items || []).filter(e => e.departments && e.departments.includes(user.dept));
        }

        const statusData = await docClient.send(new ScanCommand({ TableName: 'Lakshya_EventStatus' }));
        const statusMap = {};
        (statusData.Items || []).forEach(s => {
            // Check if status belongs to this user's scope
            if (s.deptName === user.dept || managedEventIds.includes(s.eventId)) {
                statusMap[s.eventId] = s.isOpen;
            }
        });

        const result = myEvents.map(e => ({
            eventId: e.eventId, 
            title: e.title,
            isOpen: statusMap[e.eventId] !== false 
        }));
        res.json(result);
    } catch (e) { res.status(500).json({ error: "Failed" }); }
});
app.post('/api/coordinator/toggle-event', isAuthenticated('coordinator'), async (req, res) => {
    const { eventId, isOpen } = req.body;
    const userDept = req.session.user.dept || "General";
    const statusId = `${eventId}#${userDept}`;
    const params = {
        TableName: 'Lakshya_EventStatus',
        Item: { statusId, eventId, deptName: userDept, isOpen, updatedAt: new Date().toISOString() }
    };
    try { await docClient.send(new PutCommand(params)); res.json({ message: 'Updated' }); }
    catch (e) { res.status(500).json({ error: "Update failed" }); }
});

// ===============================================
// --- ADMIN ROUTES (KEEPING AS IS) ---
// ===============================================

app.get('/api/admin/stats', isAuthenticated('admin'), async (req, res) => {
    try {
        const [users, events, regs] = await Promise.all([
            docClient.send(new ScanCommand({ TableName: 'Lakshya_Users', Select: 'COUNT' })),
            docClient.send(new ScanCommand({ TableName: 'Lakshya_Events', Select: 'COUNT' })),
            docClient.send(new ScanCommand({ TableName: 'Lakshya_Registrations' }))
        ]);
        const registrations = regs.Items || [];
        
        // --- FIXED REVENUE CALCULATION ---
        const totalRevenue = registrations.reduce((sum, r) => {
            if (r.paymentStatus === 'COMPLETED') {
                // If amountPaid exists, use it. If not (legacy data), fallback to 200.
                const paid = parseFloat(r.amountPaid);
                return sum + (isNaN(paid) ? 200 : paid);
            }
            return sum;
        }, 0);

        const deptCounts = {};
        registrations.forEach(r => { const d = r.deptName || 'General'; deptCounts[d] = (deptCounts[d] || 0) + 1; });
        const paymentCounts = { Paid: 0, Pending: 0 };
        registrations.forEach(r => r.paymentStatus === 'COMPLETED' ? paymentCounts.Paid++ : paymentCounts.Pending++);

        res.json({
            totalUsers: users.Count, totalEvents: events.Count, totalRegistrations: regs.Count,
            totalRevenue, deptCounts, paymentCounts
        });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/admin/student-details', isAuthenticated('admin'), async (req, res) => {
    const { email } = req.query;
    try {
        const data = await docClient.send(new GetCommand({ TableName: 'Lakshya_Users', Key: { email } }));
        if (data.Item) { const { password, ...d } = data.Item; res.json(d); }
        else res.status(404).json({ error: 'Not found' });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/admin/all-registrations', isAuthenticated('admin'), async (req, res) => {
    try {
        // Scans the table and returns all fields, including 'amountPaid'
        const data = await docClient.send(new ScanCommand({ TableName: 'Lakshya_Registrations' }));
        res.json(data.Items || []);
    } catch (err) { 
        console.error("Fetch All Registrations Error:", err);
        res.status(500).json({ error: 'Failed to fetch registrations' }); 
    }
});

app.post('/api/admin/create-user', isAuthenticated('admin'), async (req, res) => {
    const { email, password, role, fullName, dept } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const params = {
        TableName: 'Lakshya_Users',
        Item: { email, role, fullName, dept, password: hashedPassword, createdAt: new Date().toISOString() }
    };
    try { await docClient.send(new PutCommand(params)); res.json({ message: 'User created' }); }
    catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/admin/departments', async (req, res) => {
    try {
        const data = await docClient.send(new ScanCommand({ TableName: 'Lakshya_Departments' }));
        res.json(data.Items || []);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// --- ADD EVENT ENDPOINT ---
app.post('/api/admin/add-event', isAuthenticated('admin'), upload.single('image'), async (req, res) => {
    try {
        const { title, type, description, teamSize, fee, departments, sections } = req.body;
        let imageUrl = 'default.jpg';
        
        // Handle File Upload
        if (req.file) {
            const fileName = `events/${uuidv4()}-${req.file.originalname}`;
            const uploadParams = {
                Bucket: 'lakshya-assets-2k26-prod-12345', 
                Key: fileName,
                Body: req.file.buffer, 
                ContentType: req.file.mimetype
            };
            await s3Client.send(new PutObjectCommand(uploadParams));
            imageUrl = `https://lakshya-assets-2k26-prod-12345.s3.ap-south-1.amazonaws.com/${fileName}`;
        }

        // Create Event Item
        const eventId = uuidv4();
        const params = {
            TableName: 'Lakshya_Events',
            Item: {
                eventId, 
                title, 
                type, 
                description, 
                teamSize, 
                fee,
                // Parse the JSON strings sent by FormData
                departments: JSON.parse(departments), 
                sections: JSON.parse(sections),
                imageUrl, 
                createdAt: new Date().toISOString()
            }
        };
        await docClient.send(new PutCommand(params));
        res.json({ message: 'Event created' });
    } catch (err) { 
        console.error("Add Event Error:", err);
        res.status(500).json({ error: 'Failed' }); 
    }
});
app.post('/api/admin/add-department', isAuthenticated('admin'), async (req, res) => {
    const { name } = req.body;
    try {
        await docClient.send(new PutCommand({
            TableName: 'Lakshya_Departments',
            Item: { deptId: uuidv4(), name: name.toUpperCase(), createdAt: new Date().toISOString() }
        }));
        res.json({ message: 'Added' });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/admin/delete-department', isAuthenticated('admin'), async (req, res) => {
    try {
        await docClient.send(new DeleteCommand({ TableName: 'Lakshya_Departments', Key: { deptId: req.body.deptId } }));
        res.json({ message: 'Deleted' });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/events', async (req, res) => {
    try {
        const data = await docClient.send(new ScanCommand({ TableName: 'Lakshya_Events' }));
        res.json(data.Items || []);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/admin/save-scheme', isAuthenticated('admin'), async (req, res) => {
    const { eventId, deptName, criteria } = req.body;
    const schemeId = `${eventId}#${deptName}`;
    const params = {
        TableName: 'Lakshya_ScoringSchemes',
        Item: { schemeId, eventId, deptName, criteria: JSON.parse(criteria), isLocked: false, updatedAt: new Date().toISOString() },
        ConditionExpression: 'attribute_not_exists(schemeId)'
    };
    try { await docClient.send(new PutCommand(params)); res.json({ message: 'Saved' }); }
    catch (err) { res.status(400).json({ error: 'Already exists' }); }
});

app.get('/api/admin/all-schemes', isAuthenticated('admin'), async (req, res) => {
    try {
        const data = await docClient.send(new ScanCommand({ TableName: 'Lakshya_ScoringSchemes' }));
        res.json(data.Items || []);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/admin/update-scheme', isAuthenticated('admin'), async (req, res) => {
    const { schemeId, criteria, isLocked } = req.body;
    const params = {
        TableName: 'Lakshya_ScoringSchemes', Key: { schemeId },
        UpdateExpression: "set criteria = :c, isLocked = :l, updatedAt = :u",
        ExpressionAttributeValues: { ":c": JSON.parse(criteria), ":l": isLocked, ":u": new Date().toISOString() }
    };
    try { await docClient.send(new UpdateCommand(params)); res.json({ message: 'Updated' }); }
    catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/admin/delete-scheme', isAuthenticated('admin'), async (req, res) => {
    try {
        await docClient.send(new DeleteCommand({ TableName: 'Lakshya_ScoringSchemes', Key: { schemeId: req.body.schemeId } }));
        res.json({ message: 'Deleted' });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// Utility Cart Endpoints
app.get('/api/cart', isAuthenticated('participant'), async (req, res) => {
    try {
        const data = await docClient.send(new GetCommand({ TableName: 'Lakshya_Cart', Key: { email: req.session.user.email } }));
        const cartItems = data.Item ? data.Item.items : [];

        // Fetch full event details for each item to determine Kit Eligibility
        const enrichedItems = await Promise.all(cartItems.map(async (item) => {
            try {
                const eventDoc = await docClient.send(new GetCommand({ TableName: 'Lakshya_Events', Key: { eventId: item.eventId } }));
                const event = eventDoc.Item || {};
                
                return {
                    ...item,
                    eventName: event.title || item.eventName, // Ensure name is up to date
                    category: event.type,
                    includesKit: checkKitEligibility(event.type) // FRONTEND: Use this to show badge
                };
            } catch (e) {
                return item;
            }
        }));

        res.json(enrichedItems);
    } catch (err) { 
        console.error("Cart Error:", err);
        res.status(500).json({ error: 'Failed' }); 
    }
});


app.post('/api/cart', isAuthenticated('participant'), async (req, res) => {
    try {
        await docClient.send(new PutCommand({
            TableName: 'Lakshya_Cart',
            Item: { email: req.session.user.email, items: req.body.items, updatedAt: new Date().toISOString() }
        }));
        res.json({ message: 'Saved' });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});
app.delete('/api/cart', isAuthenticated('participant'), async (req, res) => {
    try {
        await docClient.send(new DeleteCommand({ TableName: 'Lakshya_Cart', Key: { email: req.session.user.email } }));
        res.json({ message: 'Cleared' });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/admin/export-data', isAuthenticated('admin'), async (req, res) => {
    const { emails } = req.body;
    if (!emails || !Array.isArray(emails)) return res.json({});
    try {
        const userPromises = [...new Set(emails)].map(email => 
            docClient.send(new GetCommand({
                TableName: 'Lakshya_Users', Key: { email },
                ProjectionExpression: 'email, fullName, mobile, college, rollNo, dept, #y',
                ExpressionAttributeNames: { "#y": "year" }
            }))
        );
        const results = await Promise.all(userPromises);
        const userMap = {};
        results.forEach(r => { if (r.Item) userMap[r.Item.email] = r.Item; });
        res.json(userMap);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/admin/scores', isAuthenticated('admin'), async (req, res) => {
    const { eventId, deptName } = req.query;
    try {
        const scanParams = { TableName: 'Lakshya_Registrations', FilterExpression: 'attribute_exists(totalScore)' };
        const filters = []; const attrValues = {}; const attrNames = {};

        if (eventId && eventId !== 'all') { filters.push('eventId = :eid'); attrValues[':eid'] = eventId; }
        if (deptName && deptName !== 'all') { filters.push('#d = :dn'); attrValues[':dn'] = deptName; attrNames['#d'] = 'deptName'; }

        if (filters.length > 0) {
            scanParams.FilterExpression += ' AND ' + filters.join(' AND ');
            scanParams.ExpressionAttributeValues = attrValues;
            if (Object.keys(attrNames).length > 0) scanParams.ExpressionAttributeNames = attrNames;
        }

        const data = await docClient.send(new ScanCommand(scanParams));
        let items = data.Items || [];
        items.sort((a, b) => parseFloat(b.totalScore) - parseFloat(a.totalScore));
        res.json(items);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/admin/delete-event', isAuthenticated('admin'), async (req, res) => {
    try {
        await docClient.send(new DeleteCommand({ TableName: 'Lakshya_Events', Key: { eventId: req.body.eventId } }));
        res.json({ message: 'Deleted' });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/admin/update-event', isAuthenticated('admin'), upload.single('image'), async (req, res) => {
    try {
        const { eventId, title, type, description, fee, departments, sections } = req.body;
        
        let updateExp = "set title=:t, #type=:ty, description=:d, fee=:f, departments=:depts, sections=:sec";
        let expValues = { 
            ':t': title, 
            ':ty': type, 
            ':d': description, 
            ':f': fee, 
            ':depts': JSON.parse(departments), 
            ':sec': JSON.parse(sections) 
        };

        if (req.file) {
            const fileName = `events/${uuidv4()}-${req.file.originalname}`;
            await s3Client.send(new PutObjectCommand({ 
                Bucket: 'lakshya-assets-2k26-prod-12345', 
                Key: fileName, 
                Body: req.file.buffer, 
                ContentType: req.file.mimetype 
            }));
            updateExp += ", imageUrl=:img";
            expValues[':img'] = `https://lakshya-assets-2k26-prod-12345.s3.ap-south-1.amazonaws.com/${fileName}`;
        }

        await docClient.send(new UpdateCommand({
            TableName: 'Lakshya_Events', 
            Key: { eventId }, 
            UpdateExpression: updateExp, 
            ExpressionAttributeValues: expValues, 
            ExpressionAttributeNames: { "#type": "type" } // 'type' is a reserved word
        }));
        res.json({ message: 'Updated' });
    } catch (err) { 
        console.error("Update Event Error:", err);
        res.status(500).json({ error: 'Failed' }); 
    }
});// Committee & Misc
app.post('/api/admin/add-committee-member', isAuthenticated('admin'), upload.single('image'), async (req, res) => {
    try {
        const { name, role, category } = req.body;
        let imageUrl = 'assets/default-user.png';
        if (req.file) {
            const fileName = `committee/${uuidv4()}-${req.file.originalname}`;
            await s3Client.send(new PutObjectCommand({ Bucket: 'lakshya-assets-2k26-prod-12345', Key: fileName, Body: req.file.buffer, ContentType: req.file.mimetype }));
            imageUrl = `https://lakshya-assets-2k26-prod-12345.s3.ap-south-1.amazonaws.com/${fileName}`;
        }
        await docClient.send(new PutCommand({
            TableName: 'Lakshya_Committee',
            Item: { memberId: uuidv4(), name, role, category, imageUrl, createdAt: new Date().toISOString() }
        }));
        res.json({ message: 'Added' });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/committee', async (req, res) => {
    try {
        const data = await docClient.send(new ScanCommand({ TableName: 'Lakshya_Committee' }));
        res.json(data.Items || []);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});
app.post('/api/admin/delete-committee-member', isAuthenticated('admin'), async (req, res) => {
    try {
        await docClient.send(new DeleteCommand({ TableName: 'Lakshya_Committee', Key: { memberId: req.body.memberId } }));
        res.json({ message: 'Deleted' });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/auth/forgot-password-request', async (req, res) => {
    const { email } = req.body;
    try {
        const userCheck = await docClient.send(new GetCommand({ TableName: 'Lakshya_Users', Key: { email } }));
        if (!userCheck.Item) return res.status(404).json({ error: 'Email not registered' });
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        await docClient.send(new UpdateCommand({
            TableName: 'Lakshya_Users', Key: { email },
            UpdateExpression: "set resetOtp = :o, resetOtpExp = :e",
            ExpressionAttributeValues: { ":o": otp, ":e": Date.now() + 15 * 60 * 1000 }
        }));
        await sendEmail(email, "LAKSHYA 2K26 - Password Reset OTP", `<p>Your OTP is: <strong>${otp}</strong></p>`);
        res.json({ message: 'OTP sent' });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/auth/reset-password', async (req, res) => {
    const { email, otp, newPassword } = req.body;
    try {
        const data = await docClient.send(new GetCommand({ TableName: 'Lakshya_Users', Key: { email } }));
        const user = data.Item;
        if (!user || user.resetOtp !== otp || Date.now() > user.resetOtpExp) return res.status(400).json({ error: 'Invalid OTP' });
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await docClient.send(new UpdateCommand({
            TableName: 'Lakshya_Users', Key: { email },
            UpdateExpression: "set password = :p remove resetOtp, resetOtpExp",
            ExpressionAttributeValues: { ":p": hashedPassword }
        }));
        res.json({ message: 'Password reset successfully' });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// Coupons
app.post('/api/admin/create-coupon', isAuthenticated('admin'), async (req, res) => {
    const { code, percentage, limit } = req.body;
    try {
        await docClient.send(new PutCommand({
            TableName: 'Lakshya_Coupons',
            Item: { code: code.toUpperCase(), percentage: parseInt(percentage), usageLimit: parseInt(limit), usedCount: 0, createdAt: new Date().toISOString() },
            ConditionExpression: 'attribute_not_exists(code)'
        }));
        res.json({ message: 'Created' });
    } catch (err) { res.status(400).json({ error: 'Failed' }); }
});
app.get('/api/admin/coupons', isAuthenticated('admin'), async (req, res) => {
    try {
        const data = await docClient.send(new ScanCommand({ TableName: 'Lakshya_Coupons' }));
        res.json(data.Items || []);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});
app.post('/api/admin/delete-coupon', isAuthenticated('admin'), async (req, res) => {
    try {
        await docClient.send(new DeleteCommand({ TableName: 'Lakshya_Coupons', Key: { code: req.body.code } }));
        res.json({ message: 'Deleted' });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});
// app.post('/api/payment/create-order', isAuthenticated('participant'), async (req, res) => {
//     try {
//         const { cartItems, couponCode } = req.body;
        
//         // 1. Fetch real event data
//         let events = [];
//         for (const item of cartItems) {
//             const eventDoc = await docClient.send(new GetCommand({ TableName: 'Lakshya_Events', Key: { eventId: item.eventId } }));
//             if (eventDoc.Item) {
//                 events.push({ ...eventDoc.Item, fee: parseInt(eventDoc.Item.fee) });
//             }
//         }

//         // 2. Sort events by fee (High to Low)
//         events.sort((a, b) => b.fee - a.fee);

//         let totalAmount = 0;
//         const itemAmounts = {}; 

//         // Fetch Standard Coupon
//         let standardCoupon = null;
//         if (couponCode && couponCode !== 'LAKSHYA2K26') {
//             const couponQuery = await docClient.send(new GetCommand({ TableName: 'Lakshya_Coupons', Key: { code: couponCode.toUpperCase() } }));
//             if (couponQuery.Item && couponQuery.Item.currentUses < couponQuery.Item.usageLimit) {
//                 standardCoupon = couponQuery.Item;
//             }
//         }

//         // 3. HISTORY CHECK (Combo Logic)
//         let historyCount = 0;
//         if (couponCode === 'LAKSHYA2K26' && req.session.user && req.session.user.email) {
//             try {
//                 const existingRegs = await docClient.send(new QueryCommand({
//                     TableName: 'Lakshya_Registrations',
//                     IndexName: 'StudentIndex',
//                     KeyConditionExpression: 'studentEmail = :email',
//                     ExpressionAttributeValues: { ':email': req.session.user.email }
//                 }));
//                 const regs = existingRegs.Items || [];
                
//                 for (const reg of regs) {
//                     if (reg.paymentStatus === 'COMPLETED') {
//                         const isInCart = events.some(e => String(e.eventId).trim() === String(reg.eventId).trim());
//                         if (!isInCart) {
//                              if(reg.amountPaid) historyCount++; 
//                         }
//                     }
//                 }
//             } catch (e) { console.error("History check error:", e); }
//         }

//         // 4. CALCULATE PRICES
//         let currentEligibleIndex = 0; 

//         for (const event of events) {
//             let finalItemPrice = event.fee;
//             const isEligible = isEligibleForCombo(event);

//             if (couponCode === 'LAKSHYA2K26' && isEligible) {
//                 currentEligibleIndex++;
//                 const effectivePosition = historyCount + currentEligibleIndex;

//                 if (effectivePosition > 1) {
//                     finalItemPrice = event.fee / 2; // 50% OFF
//                 }
//             } 
//             else if (standardCoupon) {
//                 const type = (event.type || '').toLowerCase();
//                 if (!type.includes('special') && standardCoupon.allowedTypes && standardCoupon.allowedTypes.includes(event.type)) {
//                     finalItemPrice = event.fee - (event.fee * standardCoupon.percentage / 100);
//                 }
//             }

//             itemAmounts[event.eventId] = finalItemPrice;
//             totalAmount += finalItemPrice;
//         }

//         // 5. Platform Fee (2.36%) & Rounding
//         const platformFee = Math.ceil(totalAmount * 0.0236);
//         const finalTotal = totalAmount + platformFee;
//         const amountInPaise = Math.round(finalTotal * 100); 

//         // 6. Create Payment Link (Redirect Method)
//         const CALLBACK_URL = "http://localhost:3000/participant/payment-success"; 

//         const paymentLink = await razorpay.paymentLink.create({
//             amount: amountInPaise, 
//             currency: "INR",
//             accept_partial: false,
//             description: "LAKSHYA 2K26 Registration",
//             customer: {
//                 name: req.session.user.name || "Student",
//                 email: req.session.user.email,
//                 contact: req.session.user.mobile || "+919000000000"
//             },
//             // FIX: Disable Email to prevent "Requesting Payment" confusion
//             notify: { 
//                 sms: true, 
//                 email: false 
//             },
//             reminder_enable: false,
//             callback_url: CALLBACK_URL,
//             callback_method: "get"
//         });

//         res.json({
//             paymentLink: paymentLink.short_url,
//             paymentLinkId: paymentLink.id,
//             itemAmounts: itemAmounts 
//         });

//     } catch (error) {
//         console.error("Order Creation Error:", error);
//         res.status(500).json({ error: "Failed to create order." });
//     }
// });
// File Upload Utility
app.post('/api/utility/upload-file', isAuthenticated('participant'), upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        const fileName = `temp_uploads/${req.session.user.email}_${uuidv4()}.${req.file.originalname.split('.').pop()}`;
        await s3Client.send(new PutObjectCommand({ Bucket: 'lakshya-assets-2k26-prod-12345', Key: fileName, Body: req.file.buffer, ContentType: req.file.mimetype }));
        res.json({ url: `https://lakshya-assets-2k26-prod-12345.s3.ap-south-1.amazonaws.com/${fileName}` });
    } catch (e) { res.status(500).json({ error: 'Upload failed' }); }
});

// Chatbot & FAQ
app.use('/api/chat', chatRoute);

app.get('/api/culturals', async (req, res) => {
    try {
        const data = await docClient.send(new ScanCommand({ TableName: 'Lakshya_Events' }));
        const culturalKeywords = ['cultural', 'music', 'dance', 'singing', 'drama', 'fashion'];
        const culturalEvents = (data.Items || []).filter(e => {
            const t = (e.type || '').toLowerCase() + (e.title || '').toLowerCase();
            return culturalKeywords.some(key => t.includes(key));
        });
        res.json(culturalEvents);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/admin/reports', isAuthenticated('admin'), (req, res) => {
    // Make sure you save the HTML file as 'reports.html' in 'public/admin/' folder
    res.sendFile(path.join(__dirname, 'public/admin/reports.html'));
});

// 2. API: Get Coupon Usage Details
app.get('/api/admin/reports/coupon-usage', isAuthenticated('admin'), async (req, res) => {
    try {
        // Scan registrations where couponUsed exists and is not "NONE"
        const params = {
            TableName: 'Lakshya_Registrations',
            FilterExpression: "attribute_exists(couponUsed) AND couponUsed <> :none",
            ExpressionAttributeValues: { ":none": "NONE" }
        };
        const data = await docClient.send(new ScanCommand(params));
        
        // Optional: Sort by date (newest first)
        const items = data.Items || [];
        items.sort((a, b) => new Date(b.registeredAt) - new Date(a.registeredAt));
        
        res.json(items);
    } catch (err) {
        console.error("Coupon Report Error:", err);
        res.status(500).json({ error: 'Failed to fetch coupon data' });
    }
});

// 3. API: Get Entire Payment History
app.get('/api/admin/reports/payments', isAuthenticated('admin'), async (req, res) => {
    try {
        // Scan registrations where payment was completed
        const params = {
            TableName: 'Lakshya_Registrations',
            FilterExpression: "paymentStatus = :s",
            ExpressionAttributeValues: { ":s": "COMPLETED" }
        };
        const data = await docClient.send(new ScanCommand(params));
        
        // Sort by payment date (newest first)
        const items = data.Items || [];
        items.sort((a, b) => new Date(b.paymentDate || b.registeredAt) - new Date(a.paymentDate || a.registeredAt));

        res.json(items);
    } catch (err) {
        console.error("Payment Report Error:", err);
        res.status(500).json({ error: 'Failed to fetch payment data' });
    }
});

app.get('/receipt-view', (req, res) => {
    // Ensure you have saved the receipt-view.html file in public/static/
    res.sendFile(path.join(__dirname, 'public/static/receipt-view.html'));
});

// B. Public API to fetch Receipt Data (No login required, for email links)
app.get('/api/public/receipt-details/:regId', async (req, res) => {
    const { regId } = req.params;
    try {
        const regData = await docClient.send(new GetCommand({ TableName: 'Lakshya_Registrations', Key: { registrationId: regId } }));
        const reg = regData.Item;
        if (!reg) return res.status(404).json({ error: 'Not found' });

        const eventData = await docClient.send(new GetCommand({ TableName: 'Lakshya_Events', Key: { eventId: reg.eventId } }));
        const userData = await docClient.send(new GetCommand({ TableName: 'Lakshya_Users', Key: { email: reg.studentEmail } }));

        res.json({
            reg: reg,
            event: eventData.Item || { title: 'Unknown Event', fee: 0 },
            user: { fullName: userData.Item?.fullName || 'Student', rollNo: userData.Item?.rollNo || '-' }
        });
    } catch (e) { res.status(500).json({ error: 'Server Error' }); }
});

app.get('/api/participant/my-registrations-data', isAuthenticated('participant'), async (req, res) => {
    const userEmail = req.session.user.email;
    try {
        const data = await docClient.send(new QueryCommand({
            TableName: 'Lakshya_Registrations', 
            IndexName: 'StudentIndex',
            KeyConditionExpression: 'studentEmail = :email',
            ExpressionAttributeValues: { ':email': userEmail }
        }));
        // Sort by date (newest first)
        const items = data.Items || [];
        items.sort((a, b) => new Date(b.registeredAt) - new Date(a.registeredAt));
        res.json(items);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// B. Endpoint to serve the Public Receipt Verification Page
app.get('/receipt-view', (req, res) => {
    // Make sure receipt-view.html exists in public/static/
    res.sendFile(path.join(__dirname, 'public/static/receipt-view.html'));
});

// C. Public API to fetch receipt details (Used by the QR code page)
app.get('/api/public/receipt-details/:regId', async (req, res) => {
    const { regId } = req.params;
    try {
        // 1. Get Registration
        const regData = await docClient.send(new GetCommand({ TableName: 'Lakshya_Registrations', Key: { registrationId: regId } }));
        const reg = regData.Item;
        if (!reg) return res.status(404).json({ error: 'Not found' });

        // 2. Get Event Details
        const eventData = await docClient.send(new GetCommand({ TableName: 'Lakshya_Events', Key: { eventId: reg.eventId } }));
        
        // 3. Get User Details
        const userData = await docClient.send(new GetCommand({ TableName: 'Lakshya_Users', Key: { email: reg.studentEmail } }));

        res.json({
            reg: reg,
            event: eventData.Item || { title: 'Unknown Event', fee: 0 },
            user: { fullName: userData.Item?.fullName || 'Student', rollNo: userData.Item?.rollNo || '-' }
        });
    } catch (e) { res.status(500).json({ error: 'Server Error' }); }
});

// Add this to your backend.js file

// --- API: Get Submissions for Coordinator ---
app.get('/api/coordinator/submissions', isAuthenticated('coordinator'), async (req, res) => {
    const user = req.session.user;
    const managedEventIds = user.managedEventIds || [];

    try {
        let items = [];
        if (managedEventIds.length > 0) {
            const promises = managedEventIds.map(eid => 
                docClient.send(new ScanCommand({
                    TableName: 'Lakshya_Registrations',
                    FilterExpression: 'eventId = :eid',
                    ExpressionAttributeValues: { ':eid': eid }
                }))
            );
            const results = await Promise.all(promises);
            results.forEach(r => { if(r.Items) items.push(...r.Items); });
        } else {
            const params = {
                TableName: 'Lakshya_Registrations',
                IndexName: 'DepartmentIndex',
                KeyConditionExpression: 'deptName = :dept',
                ExpressionAttributeValues: { ':dept': user.dept }
            };
            const data = await docClient.send(new QueryCommand(params));
            items = data.Items || [];
        }
        
        const withSubs = items.filter(r => r.submissionTitle || r.submissionUrl);
        // Sort by Date
        withSubs.sort((a, b) => new Date(b.registeredAt) - new Date(a.registeredAt));
        res.json(withSubs);
    } catch (err) { res.status(500).json({ error: "Failed" }); }
});
// --- API: Coordinator Approve Registration (Enable Payment) ---
app.post('/api/coordinator/approve-registration', isAuthenticated('coordinator'), async (req, res) => {
    const { registrationId } = req.body;
    try {
        await docClient.send(new UpdateCommand({
            TableName: 'Lakshya_Registrations',
            Key: { registrationId },
            UpdateExpression: "set approvalStatus = :a",
            ExpressionAttributeValues: { ":a": "APPROVED" }
        }));
        res.json({ message: "Registration Approved. Payment enabled for student." });
    } catch (e) { 
        console.error("Approval Error:", e);
        res.status(500).json({ error: "Failed to approve registration" }); 
    }
});
app.post('/api/coupon/validate', async (req, res) => {
    try {
        const { code, cartItems } = req.body;
        const upperCode = code.toUpperCase();

        if (upperCode === 'LAKSHYA2K26') {
            const userEmail = req.session.user ? req.session.user.email : null;
            let historyCount = 0;

            // 1. Fetch real event data for Cart Items
            let events = [];
            for (const item of cartItems) {
                const eventDoc = await docClient.send(new GetCommand({ TableName: 'Lakshya_Events', Key: { eventId: item.eventId } }));
                if (eventDoc.Item) {
                    events.push({ ...eventDoc.Item, fee: parseInt(eventDoc.Item.fee) });
                }
            }

            // 2. Sort Cart Events (High to Low)
            events.sort((a, b) => b.fee - a.fee);

            // 3. Robust History Check
            if (userEmail) {
                try {
                    const existingRegs = await docClient.send(new QueryCommand({
                        TableName: 'Lakshya_Registrations',
                        IndexName: 'StudentIndex',
                        KeyConditionExpression: 'studentEmail = :email',
                        ExpressionAttributeValues: { ':email': userEmail }
                    }));
                    
                    const regs = existingRegs.Items || [];
                    for (const reg of regs) {
                        // CRITICAL FIX: Ensure we only count PAID registrations
                        if (reg.paymentStatus === 'COMPLETED') {
                            
                            // OPTIMIZATION & BUG FIX: Use stored category if available to avoid Key mismatch issues
                            if (reg.category) {
                                // Check strict eligibility on stored category
                                const cat = reg.category.toLowerCase();
                                const eligibleKeywords = ['major', 'mba', 'management', 'cultural', 'music', 'dance', 'singing', 'drama', 'art', 'fashion', 'literary'];
                                const isEligible = eligibleKeywords.some(k => cat.includes(k)) && !cat.includes('special');
                                
                                if (isEligible) historyCount++;
                            
                            } else {
                                // Fallback: Fetch event if category missing (Trim ID to be safe)
                                const cleanId = String(reg.eventId).trim();
                                const eventDoc = await docClient.send(new GetCommand({ 
                                    TableName: 'Lakshya_Events', 
                                    Key: { eventId: cleanId } 
                                }));
                                
                                if (eventDoc.Item && isEligibleForCombo(eventDoc.Item)) {
                                    historyCount++;
                                }
                            }
                        }
                    }
                } catch (err) { console.error("History check error:", err); }
            }

            // 4. Calculate Discount
            let totalDiscount = 0;
            let currentEligibleIndex = 0;
            let eligibleItemCount = 0;

            for (const event of events) {
                if (isEligibleForCombo(event)) {
                    eligibleItemCount++;
                    currentEligibleIndex++;
                    
                    // Effective Position = History + Position in Current Cart
                    const effectivePosition = historyCount + currentEligibleIndex;

                    // STRICT RULE: Position 1 is always Full Price. Position > 1 is 50% Off.
                    if (effectivePosition > 1) {
                        totalDiscount += (event.fee * 0.5);
                    }
                }
            }

            if (eligibleItemCount === 0) {
                return res.status(400).json({ error: "No eligible events for this coupon." });
            }

            let msg = historyCount > 0 
                ? "Loyalty Offer! 50% OFF applied." 
                : "Combo Offer! 50% OFF on additional events.";

            return res.json({
                code: 'LAKSHYA2K26',
                discountAmount: totalDiscount,
                historyCount: historyCount, 
                message: msg
            });
        }

        // --- STANDARD DB COUPON LOGIC (Unchanged) ---
        const couponQuery = await docClient.send(new GetCommand({ TableName: 'Lakshya_Coupons', Key: { code: upperCode } }));
        const coupon = couponQuery.Item;
        
        if (!coupon) return res.status(404).json({ error: "Invalid coupon code." });
        if (coupon.currentUses >= coupon.usageLimit) return res.status(400).json({ error: "Coupon usage limit reached." });

        let eligibleTotal = 0;
        let cartHasEligible = false;

        for (const item of cartItems) {
            const eventDoc = await docClient.send(new GetCommand({ TableName: 'Lakshya_Events', Key: { eventId: item.eventId } }));
            if (eventDoc.Item) {
                const event = eventDoc.Item;
                if (!event.type.toLowerCase().includes('special') && coupon.allowedTypes && coupon.allowedTypes.includes(event.type)) {
                    eligibleTotal += parseInt(event.fee);
                    cartHasEligible = true;
                }
            }
        }

        if (!cartHasEligible) return res.status(400).json({ error: "Coupon not applicable." });

        const discountAmount = (eligibleTotal * coupon.percentage) / 100;

        return res.json({
            code: coupon.code,
            discountAmount: discountAmount,
            historyCount: 0, 
            message: `Coupon Applied! ${coupon.percentage}% OFF.`
        });

    } catch (error) {
        console.error("Coupon Validation Error:", error);
        res.status(500).json({ error: "Failed to validate coupon." });
    }
});
// =========================================================================
//  ENDPOINT 3: CREATE PAYMENT ORDER
//  (REPLACE YOUR EXISTING '/api/payment/create-order' ROUTE WITH THIS)
// =========================================================================
// app.post('/api/payment/create-order', async (req, res) => {
//     try {
//         const { cartItems, couponCode } = req.body;
        
//         // 1. Fetch real event data
//         let events = [];
//         for (const item of cartItems) {
//             const eventDoc = await docClient.send(new GetCommand({ TableName: 'Lakshya_Events', Key: { eventId: item.eventId } }));
//             if (eventDoc.Item) {
//                 events.push({ ...eventDoc.Item, fee: parseInt(eventDoc.Item.fee) });
//             }
//         }

//         // Sort events by fee (High to Low) so the discount applies to cheaper items first if any, 
//         // OR ensures the most expensive item is the "First" (Full Price) one if no history exists.
//         events.sort((a, b) => b.fee - a.fee);

//         let totalAmount = 0;
//         const itemAmounts = {}; // Stores specific amount for each eventId

//         // Fetch Standard Coupon if applicable
//         let standardCoupon = null;
//         if (couponCode && couponCode !== 'LAKSHYA2K26') {
//             const couponQuery = await docClient.send(new GetCommand({ TableName: 'Lakshya_Coupons', Key: { code: couponCode.toUpperCase() } }));
//             if (couponQuery.Item && couponQuery.Item.currentUses < couponQuery.Item.usageLimit) {
//                 standardCoupon = couponQuery.Item;
//             }
//         }

//         // --- HISTORY CHECK FOR COMBO ---
//         let historyCount = 0;
//         if (couponCode === 'LAKSHYA2K26' && req.session.user && req.session.user.email) {
//             try {
//                 const existingRegs = await docClient.send(new QueryCommand({
//                     TableName: 'Lakshya_Registrations',
//                     IndexName: 'StudentIndex',
//                     KeyConditionExpression: 'studentEmail = :email',
//                     ExpressionAttributeValues: { ':email': req.session.user.email }
//                 }));
//                 const regs = existingRegs.Items || [];
//                 // Count how many eligible events are ALREADY PAID
//                 for (const reg of regs) {
//                     if (reg.paymentStatus === 'COMPLETED') {
//                         // Check if this paid event is not in current cart (avoid double count)
//                         const isInCart = events.some(e => e.eventId === reg.eventId);
//                         if (!isInCart) {
//                             // We need to check if the *past* event was eligible type
//                             // Fetching event details might be slow, so we assume Major/Cultural are tracked
//                             // Optimisation: Check reg.category if saved, or fetch event
//                             const eventDoc = await docClient.send(new GetCommand({ TableName: 'Lakshya_Events', Key: { eventId: reg.eventId } }));
//                             if (eventDoc.Item && isEligibleForCombo(eventDoc.Item)) {
//                                 historyCount++;
//                             }
//                         }
//                     }
//                 }
//             } catch (e) { console.error("History check error:", e); }
//         }

//         // 2. LOGIC FIX: Calculate exact amount per item strictly
//         let currentEligibleIndex = 0; // Tracks eligible items in THIS cart

//         for (const event of events) {
//             let finalItemPrice = event.fee;
//             const isEligible = isEligibleForCombo(event);

//             if (couponCode === 'LAKSHYA2K26' && isEligible) {
//                 currentEligibleIndex++;
                
//                 // Effective Position = History + Current Position
//                 // Example: 0 History + 1st Item = 1. (No Discount)
//                 // Example: 0 History + 2nd Item = 2. (Discount)
//                 // Example: 1 History + 1st Item = 2. (Discount)
//                 const effectivePosition = historyCount + currentEligibleIndex;

//                 if (effectivePosition > 1) {
//                     finalItemPrice = event.fee / 2; // 50% OFF for 2nd, 3rd, 4th...
//                 } else {
//                     finalItemPrice = event.fee; // Full Price for 1st
//                 }
//             } 
//             else if (standardCoupon) {
//                 // Standard Coupon Logic (Per Item)
//                 const type = (event.type || '').toLowerCase();
//                 if (!type.includes('special') && standardCoupon.allowedTypes && standardCoupon.allowedTypes.includes(event.type)) {
//                     finalItemPrice = event.fee - (event.fee * standardCoupon.percentage / 100);
//                 }
//             }

//             // Map event ID to its specific calculated price
//             itemAmounts[event.eventId] = finalItemPrice;
//             totalAmount += finalItemPrice;
//         }

//         // 3. Platform Fee (2.36%)
//         const platformFee = Math.ceil(totalAmount * 0.0236);
//         const finalTotal = totalAmount + platformFee;

//         // 4. Create Razorpay Order
//         const order = await razorpay.orders.create({
//             amount: finalTotal * 100, // Amount in paise
//             currency: "INR",
//             receipt: "receipt_" + Date.now()
//         });

//         // 5. Return the key details AND the specific breakdown
//         res.json({
//             id: order.id,
//             amount: order.amount,
//             currency: order.currency,
//             key_id: RAZORPAY_KEY_ID,
//             itemAmounts: itemAmounts // SEND THIS BACK
//         });

//     } catch (error) {
//         console.error("Order Creation Error:", error);
//         res.status(500).json({ error: "Failed to create order." });
//     }
// });

router.post('/api/admin/add-coupon', async (req, res) => {
    try {
        const { code, discountPercentage, allowedTypes, maxUses } = req.body;

        // 1. Hard Block for "Special" Events
        // Even if Admin tries to select it, backend rejects it.
        if (allowedTypes.some(type => type.toLowerCase().includes('special'))) {
            return res.status(400).json({ 
                error: "Security Alert: Coupons cannot be created for Special Events." 
            });
        }

        // 2. Validate standard types
        const validTypes = ['Major', 'MBA', 'Cultural'];
        const isValid = allowedTypes.every(t => validTypes.includes(t));
        
        if (!isValid) {
            return res.status(400).json({ 
                error: "Invalid Event Type detected. Only Major, MBA, and Cultural events are allowed." 
            });
        }

        // 3. Save to Database
        await db.collection('coupons').add({
            code: code.toUpperCase(),
            discountPercentage: parseInt(discountPercentage),
            allowedTypes: allowedTypes,
            maxUses: parseInt(maxUses) || 500,
            currentUses: 0,
            totalSavingsGiven: 0, // Track total money saved by students
            createdAt: new Date().toISOString()
        });

        res.json({ success: true, message: "Coupon created successfully!" });

    } catch (error) {
        console.error("Add Coupon Error:", error);
        res.status(500).json({ error: "Failed to create coupon." });
    }
});

// ==========================================


// 2. ADMIN: VIEW USAGE STATS (Data for Admin Page)
// ==========================================
app.get('/api/admin/coupon-usage', isAuthenticated('admin'), async (req, res) => {
    try {
        const data = await docClient.send(new ScanCommand({ TableName: 'Lakshya_Coupons' }));
        const usageData = (data.Items || []).map(coupon => ({
            id: coupon.code, // Use Code as ID
            code: coupon.code,
            discount: coupon.percentage + '%',
            validFor: (coupon.allowedTypes || []).join(', '),
            used: `${coupon.currentUses || 0} / ${coupon.usageLimit}`,
            totalSaved: `₹${coupon.totalSavingsGiven || 0}`,
            status: (coupon.currentUses >= coupon.usageLimit) ? 'Expired' : 'Active'
        }));

        res.json(usageData);
    } catch (error) {
        console.error("Fetch Usage Error:", error);
        res.status(500).json({ error: "Failed to fetch coupon stats." });
    }
});

app.get('/api/coordinator/approvals', isAuthenticated('coordinator'), async (req, res) => {
    try {
        const user = req.session.user;
        const managedEventIds = user.managedEventIds || [];
        let items = [];

        // SCENARIO 1: Multi-Event Coordinator
        if (managedEventIds.length > 0) {
            // Fetch PENDING regs for all 3 events
            const promises = managedEventIds.map(eid => 
                docClient.send(new ScanCommand({
                    TableName: 'Lakshya_Registrations',
                    FilterExpression: 'eventId = :eid AND paymentStatus = :status',
                    ExpressionAttributeValues: { ':eid': eid, ':status': 'PENDING' }
                }))
            );
            const results = await Promise.all(promises);
            results.forEach(r => { if(r.Items) items.push(...r.Items); });
        } 
        // SCENARIO 2: Department Coordinator
        else {
            const params = {
                TableName: 'Lakshya_Registrations',
                IndexName: 'DepartmentIndex',
                KeyConditionExpression: 'deptName = :dept',
                FilterExpression: 'paymentStatus = :status',
                ExpressionAttributeValues: { ':dept': user.dept, ':status': 'PENDING' }
            };
            const data = await docClient.send(new QueryCommand(params));
            items = data.Items || [];
        }

        if (items.length === 0) return res.json([]);

        // --- FETCH NAMES & TITLES FOR DISPLAY ---
        const eventData = await docClient.send(new ScanCommand({ TableName: 'Lakshya_Events' }));
        const eventMap = {};
        (eventData.Items || []).forEach(e => eventMap[e.eventId] = e.title);

        const formattedRequests = await Promise.all(items.map(async (reg) => {
            let userName = "Unknown";
            let userRoll = "N/A";
            try {
                const userRes = await docClient.send(new GetCommand({
                    TableName: 'Lakshya_Users', Key: { email: reg.studentEmail }
                }));
                if (userRes.Item) {
                    userName = userRes.Item.fullName;
                    userRoll = userRes.Item.rollNo;
                }
            } catch (e) {}

            return {
                id: reg.registrationId,
                name: reg.teamName ? reg.teamName : userName,
                roll: userRoll,
                event: eventMap[reg.eventId] || reg.eventId,
                type: reg.teamName ? 'Team' : 'Individual',
                status: reg.paymentStatus,
                txId: reg.transactionId || 'N/A',
                proofUrl: reg.screenshotUrl || '',
                timestamp: reg.registeredAt
            };
        }));

        res.json(formattedRequests);

    } catch (error) {
        console.error("Error fetching approvals:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});
// 2. POST: Approve Request
app.post('/api/coordinator/approve', isAuthenticated('coordinator'), async (req, res) => {
    try {
        const { id } = req.body; 

        if (!id) return res.status(400).json({ error: "Registration ID is required" });

        // Update status to COMPLETED in DynamoDB
        const params = {
            TableName: 'Lakshya_Registrations',
            Key: { registrationId: id },
            UpdateExpression: "set paymentStatus = :s",
            ExpressionAttributeValues: { ":s": "COMPLETED" },
            ReturnValues: "ALL_NEW"
        };

        const result = await docClient.send(new UpdateCommand(params));
        
        // Optional: Trigger Email Notification here if needed
        // const reg = result.Attributes;
        // sendEmail(reg.studentEmail, "Approved", "Your registration is approved.");

        res.json({ success: true, message: "Request approved successfully" });

    } catch (error) {
        console.error("Error approving request:", error);
        res.status(500).json({ error: "Failed to approve request" });
    }
});

// 3. POST: Decline Request
app.post('/api/coordinator/decline', isAuthenticated('coordinator'), async (req, res) => {
    try {
        const { id, reason } = req.body;

        if (!id || !reason) return res.status(400).json({ error: "ID and Reason are required" });

        // Update status to REJECTED and add remarks in DynamoDB
        const params = {
            TableName: 'Lakshya_Registrations',
            Key: { registrationId: id },
            UpdateExpression: "set paymentStatus = :s, remarks = :r",
            ExpressionAttributeValues: { 
                ":s": "REJECTED",
                ":r": reason
            }
        };

        await docClient.send(new UpdateCommand(params));

        res.json({ success: true, message: "Request declined successfully" });

    } catch (error) {
        console.error("Error declining request:", error);
        res.status(500).json({ error: "Failed to decline request" });
    }
});

app.get('/api/coordinator/kit-beneficiaries', isAuthenticated('coordinator'), async (req, res) => {
    try {
        const user = req.session.user;
        const managedEventIds = user.managedEventIds || [];
        let items = [];

        if (managedEventIds.length > 0) {
            const promises = managedEventIds.map(eid => 
                docClient.send(new ScanCommand({
                    TableName: 'Lakshya_Registrations',
                    FilterExpression: 'eventId = :eid AND paymentStatus = :status',
                    ExpressionAttributeValues: { ':eid': eid, ':status': 'COMPLETED' }
                }))
            );
            const results = await Promise.all(promises);
            results.forEach(r => { if(r.Items) items.push(...r.Items); });
        } else {
            const params = {
                TableName: 'Lakshya_Registrations',
                IndexName: 'DepartmentIndex',
                KeyConditionExpression: 'deptName = :dept',
                FilterExpression: 'paymentStatus = :status',
                ExpressionAttributeValues: { ':dept': user.dept, ':status': 'COMPLETED' }
            };
            const data = await docClient.send(new QueryCommand(params));
            items = data.Items || [];
        }

        if (items.length === 0) return res.json([]);

        // --- FILTER FOR KIT ELIGIBILITY ---
        const eventData = await docClient.send(new ScanCommand({ TableName: 'Lakshya_Events' }));
        const eventMap = {}; 
        (eventData.Items || []).forEach(e => {
            eventMap[e.eventId] = { 
                title: e.title, 
                fee: parseFloat(e.fee), 
                type: (e.type || '').toLowerCase(),
                includesKit: checkKitEligibility(e.type) // Uses your existing helper
            };
        });

        const beneficiaries = [];
        for (const reg of items) {
            const eventInfo = eventMap[reg.eventId];
            if (!eventInfo || !eventInfo.includesKit) continue;

            // Check if full fee paid
            const amountPaid = parseFloat(reg.amountPaid) || 0;
            if (amountPaid < (eventInfo.fee - 1)) continue;

            // Get User Details
            let studentName = "Unknown", rollNo = "N/A", mobile = "N/A";
            try {
                const userRes = await docClient.send(new GetCommand({
                    TableName: 'Lakshya_Users', Key: { email: reg.studentEmail }
                }));
                if (userRes.Item) {
                    studentName = userRes.Item.fullName;
                    rollNo = userRes.Item.rollNo;
                    mobile = userRes.Item.mobile;
                }
            } catch (e) {}

            beneficiaries.push({
                registrationId: reg.registrationId, 
                eventId: reg.eventId,
                studentName, studentEmail: reg.studentEmail, rollNo, mobile,
                eventTitle: eventInfo.title,        
                eventType: eventInfo.type,          
                dept: reg.deptName,
                kitCollected: reg.kitCollected === true,
                attendance: reg.attendance === true 
            });
        }

        beneficiaries.sort((a, b) => a.studentName.localeCompare(b.studentName));
        res.json(beneficiaries);

    } catch (error) {
        res.status(500).json({ error: "Failed to fetch list" });
    }
});

app.post('/api/coordinator/toggle-kit-status', isAuthenticated('coordinator'), async (req, res) => {
    const { registrationId, status } = req.body;

    try {
        // 1. Fetch current registration
        const getRes = await docClient.send(new GetCommand({
            TableName: 'Lakshya_Registrations',
            Key: { registrationId }
        }));
        
        const reg = getRes.Item;
        if (!reg) return res.status(404).json({ error: "Registration not found" });

        // 2. Attendance Check
        if (status === true && reg.attendance !== true) {
            return res.status(400).json({ error: "Student must be marked PRESENT first." });
        }

        // 3. Update Kit Status
        await docClient.send(new UpdateCommand({
            TableName: 'Lakshya_Registrations',
            Key: { registrationId },
            UpdateExpression: "set kitCollected = :k, kitCollectedAt = :t",
            ExpressionAttributeValues: { 
                ":k": status,
                ":t": new Date().toISOString()
            }
        }));

        // 4. COUPON GENERATION LOGIC (NEW)
        if (status === true) {
            // Check if coupons already exist for this registration to ensure idempotency
            // FIX: 'source' is a reserved keyword, so we use ExpressionAttributeNames (#src)
            const couponCheck = await docClient.send(new ScanCommand({
                TableName: 'Lakshya_FoodCoupons',
                FilterExpression: '#src = :src',
                ExpressionAttributeNames: { '#src': 'source' },
                ExpressionAttributeValues: { ':src': registrationId }
            }));

            // Fetch Student Name & Event Title for Email
            let studentName = reg.teamName || "Student";
            let eventTitle = "LAKSHYA 2K26 Event";

            // Try to get real name from Users table
            try {
                const u = await docClient.send(new GetCommand({ TableName: 'Lakshya_Users', Key: { email: reg.studentEmail }}));
                if(u.Item) studentName = u.Item.fullName;
                
                const e = await docClient.send(new GetCommand({ TableName: 'Lakshya_Events', Key: { eventId: reg.eventId }}));
                if(e.Item) eventTitle = e.Item.title;
            } catch(e){}

            // Generate Coupons if they don't exist
            if (couponCheck.Count === 0) {
                await generateCouponsForUser(reg.studentEmail, studentName, registrationId);
                console.log(`Coupons generated for ${registrationId}`);
            }

            // 5. SEND EMAIL NOTIFICATION
            const emailSubject = "Kit Collected & Coupons Active! 🍔 | LAKSHYA 2K26";
            const emailHtml = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; background-color: #ffffff; border-radius: 8px; overflow: hidden;">
                
                <!-- Header -->
                <div style="background: linear-gradient(135deg, #00d2ff, #3a7bd5); padding: 20px; text-align: center;">
                     <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: bold; letter-spacing: 1px;">LAKSHYA 2K26</h1>
                     <p style="color: #eafaff; margin: 5px 0 0; font-size: 14px;">Kit Distribution Update</p>
                </div>

                <div style="padding: 30px;">
                    <p style="font-size: 16px; color: #333;">Dear <strong>${studentName}</strong>,</p>
                    
                    <p style="font-size: 15px; color: #555; line-height: 1.6;">
                        This is to confirm that your event kit for <strong>${eventTitle}</strong> has been successfully collected.
                    </p>
                    
                    <!-- Coupon Highlight Box -->
                    <div style="background-color: #f0fbff; border: 1px dashed #00d2ff; padding: 20px; border-radius: 8px; margin: 25px 0; text-align: center;">
                        <h3 style="color: #0077ff; margin: 0 0 10px 0;">🍔 Food Coupons Activated!</h3>
                        <p style="color: #555; font-size: 14px; margin: 0;">
                            <strong>2 Digital Food Coupons</strong> have been added to your account.
                        </p>
                        <div style="margin-top: 15px;">
                            <a href="http://localhost:3000/my-coupons?id=${registrationId}" 
                               style="background-color: #ff00cc; color: white; padding: 10px 20px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 14px; display: inline-block;">
                               View My QR Codes
                            </a>
                        </div>
                    </div>

                    <p style="font-size: 14px; color: #666;">
                        <strong>Note:</strong> Show the QR code from the "My Coupons" section to the stall vendor to redeem your food. Do not share screenshots with others.
                    </p>

                    <div style="margin-top: 30px; border-top: 1px solid #eee; padding-top: 20px;">
                        <p style="color: #888; font-size: 13px; margin: 0;">Best Regards,<br>Team LAKSHYA</p>
                    </div>
                </div>
            </div>`;

            // Fire and forget email
            sendEmail(reg.studentEmail, emailSubject, emailHtml).catch(err => console.error("Kit Email Failed:", err));
        }

        res.json({ message: "Updated successfully & Coupons Generated" });

    } catch (e) {
        console.error("Toggle Kit Error:", e);
        res.status(500).json({ error: "Failed to update status" });
    }
});

app.get('/api/admin/kit-stats', isAuthenticated('admin'), async (req, res) => {
    try {
        const { dept } = req.query; // 'All' or specific dept name

        let items = [];
        
        // 1. Fetch Registrations (Completed Only)
        if (!dept || dept === 'All') {
            // Scan all COMPLETED registrations
            const params = {
                TableName: 'Lakshya_Registrations',
                FilterExpression: 'paymentStatus = :status',
                ExpressionAttributeValues: { ':status': 'COMPLETED' }
            };
            const data = await docClient.send(new ScanCommand(params));
            items = data.Items || [];
        } else {
            // Query by Dept
            const params = {
                TableName: 'Lakshya_Registrations',
                IndexName: 'DepartmentIndex',
                KeyConditionExpression: 'deptName = :dept',
                FilterExpression: 'paymentStatus = :status',
                ExpressionAttributeValues: { ':dept': dept, ':status': 'COMPLETED' }
            };
            const data = await docClient.send(new QueryCommand(params));
            items = data.Items || [];
        }

        if (items.length === 0) return res.json([]);

        // 2. Fetch Events for Kit Eligibility Check
        const eventData = await docClient.send(new ScanCommand({ TableName: 'Lakshya_Events' }));
        const eventMap = {};
        (eventData.Items || []).forEach(e => {
            eventMap[e.eventId] = { 
                title: e.title, 
                fee: parseFloat(e.fee), 
                type: (e.type || '').toLowerCase(),
                includesKit: checkKitEligibility(e.type)
            };
        });

        // 3. Process Data
        const beneficiaries = [];
        
        await Promise.all(items.map(async (reg) => {
            const eventInfo = eventMap[reg.eventId];
            if (!eventInfo) return;
            if (!eventInfo.includesKit) return; // Must be eligible type

            // Fee Check (Must be full payment)
            const amountPaid = parseFloat(reg.amountPaid) || 0;
            if (amountPaid < (eventInfo.fee - 1)) return;

            // Fetch User Details
            let studentName = "Unknown";
            let rollNo = "-";
            
            try {
                const userRes = await docClient.send(new GetCommand({
                    TableName: 'Lakshya_Users', Key: { email: reg.studentEmail }
                }));
                if(userRes.Item) {
                    studentName = userRes.Item.fullName;
                    rollNo = userRes.Item.rollNo;
                }
            } catch(e) {}

            beneficiaries.push({
                registrationId: reg.registrationId,
                studentName: studentName,
                rollNo: rollNo,
                dept: reg.deptName,
                eventTitle: eventInfo.title,
                eventType: eventInfo.type,
                kitCollected: reg.kitCollected === true,
                kitCollectedAt: reg.kitCollectedAt || null
            });
        }));

        // Sort by Name
        beneficiaries.sort((a, b) => a.studentName.localeCompare(b.studentName));

        res.json(beneficiaries);

    } catch (e) {
        console.error("Admin Kit Stats Error:", e);
        res.status(500).json({ error: "Failed to fetch stats" });
    }
});

app.post('/api/support/create', isAuthenticated('participant'), async (req, res) => {
    const { category, subject, description } = req.body;
    const user = req.session.user;
    
    if (!category || !subject || !description) {
        return res.status(400).json({ error: "All fields are required" });
    }

    const queryId = uuidv4();
    
    // We repurpose 'Lakshya_Registrations' fields to store query data
    // eventId = 'QUERY' acts as a filter to distinguish these from real events
    const params = {
        TableName: 'Lakshya_Registrations',
        Item: {
            registrationId: queryId,        // PK
            studentEmail: user.email,       // userId (for Index)
            eventId: 'QUERY',               // Flag to identify this is a query
            
            // Mapping fields:
            deptName: category,             // Stores Category
            teamName: subject,              // Stores Subject
            submissionAbstract: description,// Stores Description
            paymentStatus: 'OPEN',          // Stores Status (OPEN/RESOLVED)
            remarks: null,                  // Stores Admin Reply
            
            // Extra metadata
            studentName: user.name || 'Participant',
            rollNo: user.rollNo || '-',
            registeredAt: new Date().toISOString()
        }
    };

    try {
        await docClient.send(new PutCommand(params));
        res.json({ message: 'Query submitted successfully', queryId });
    } catch (err) {
        console.error("Query Create Error:", err);
        res.status(500).json({ error: "Failed to submit query" });
    }
});

// 2. PARTICIPANT: Get My Queries History
app.get('/api/support/my-queries', isAuthenticated('participant'), async (req, res) => {
    try {
        // Fetch from Registrations using Student Index
        const params = {
            TableName: 'Lakshya_Registrations',
            IndexName: 'StudentIndex',
            KeyConditionExpression: 'studentEmail = :u',
            ExpressionAttributeValues: { ':u': req.session.user.email }
        };
        
        const data = await docClient.send(new QueryCommand(params));
        const allItems = data.Items || [];
        
        // Filter ONLY Query items and Map back to expected frontend format
        const queries = allItems
            .filter(item => item.eventId === 'QUERY')
            .map(item => ({
                queryId: item.registrationId,
                category: item.deptName,
                subject: item.teamName,
                description: item.submissionAbstract,
                status: item.paymentStatus,
                adminReply: item.remarks,
                createdAt: item.registeredAt
            }));
        
        // Sort: Newest first
        queries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        
        res.json(queries);
    } catch (err) {
        console.error("Fetch Queries Error:", err);
        res.status(500).json({ error: "Failed to fetch queries" });
    }
});

// 3. ADMIN: Get All Queries
app.get('/api/admin/all-queries', isAuthenticated('admin'), async (req, res) => {
    try {
        // Scan Registrations
        const data = await docClient.send(new ScanCommand({ TableName: 'Lakshya_Registrations' }));
        const allItems = data.Items || [];
        
        // Filter & Map
        const queries = allItems
            .filter(item => item.eventId === 'QUERY')
            .map(item => ({
                queryId: item.registrationId,
                userId: item.studentEmail,
                userName: item.studentName || 'Student',
                rollNo: item.rollNo || '-',
                category: item.deptName,
                subject: item.teamName,
                description: item.submissionAbstract,
                status: item.paymentStatus,
                adminReply: item.remarks,
                createdAt: item.registeredAt
            }));
        
        // Sort: OPEN tickets first
        queries.sort((a, b) => {
            if (a.status === 'OPEN' && b.status !== 'OPEN') return -1;
            if (a.status !== 'OPEN' && b.status === 'OPEN') return 1;
            return new Date(b.createdAt) - new Date(a.createdAt);
        });
        
        res.json(queries);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch queries" });
    }
});

// 4. ADMIN: Resolve Query & Send Email
app.post('/api/admin/resolve-query', isAuthenticated('admin'), async (req, res) => {
    const { queryId, reply } = req.body;
    
    if (!queryId || !reply) return res.status(400).json({ error: "Reply is required" });

    try {
        // A. Fetch original query (registration) to get user details
        const qData = await docClient.send(new GetCommand({ TableName: 'Lakshya_Registrations', Key: { registrationId: queryId } }));
        const query = qData.Item;

        if(!query) return res.status(404).json({ error: "Query not found" });

        // B. Update Status in DB (paymentStatus -> RESOLVED, remarks -> reply)
        const params = {
            TableName: 'Lakshya_Registrations',
            Key: { registrationId: queryId },
            UpdateExpression: "set paymentStatus = :s, remarks = :r, resolvedAt = :t",
            ExpressionAttributeValues: {
                ":s": "RESOLVED",
                ":r": reply,
                ":t": new Date().toISOString()
            }
        };
        await docClient.send(new UpdateCommand(params));

        // C. Send Email Notification
        const emailHtml = `
            <div style="font-family: 'Segoe UI', sans-serif; padding: 25px; border: 1px solid #eee; max-width: 600px; background-color: #ffffff;">
                <h2 style="color: #00d2ff; margin-top: 0;">Support Request Resolved</h2>
                <p>Dear ${query.studentName},</p>
                <p>Your query has been answered by the admin team.</p>
                
                <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
                    <p style="margin: 5px 0; font-size: 12px; color: #888;">SUBJECT</p>
                    <p style="margin: 0 0 15px 0; font-weight: bold;">${query.teamName}</p>
                    
                    <p style="margin: 5px 0; font-size: 12px; color: #888;">YOUR QUERY</p>
                    <p style="margin: 0 0 15px 0;">${query.submissionAbstract}</p>
                    
                    <div style="border-top: 1px solid #ddd; margin: 10px 0;"></div>
                    
                    <p style="margin: 10px 0 5px 0; font-size: 12px; color: #00d2ff; font-weight: bold;">ADMIN RESPONSE</p>
                    <p style="margin: 0; color: #333;">${reply}</p>
                </div>

                <p style="color: #666; font-size: 13px;">If you have further questions, please raise a new ticket.</p>
                <p style="color: #aaa; font-size: 12px;">Lakshya Support Team</p>
            </div>
        `;
        
        sendEmail(query.studentEmail, `[Resolved] Query: ${query.teamName}`, emailHtml).catch(console.error);

        res.json({ message: "Query resolved and email sent." });

    } catch (err) {
        console.error("Resolve Error:", err);
        res.status(500).json({ error: "Failed to resolve query" });
    }
});

// --- API: Get All Active Users (Admin Only) ---
app.get('/api/admin/all-users', isAuthenticated('admin'), async (req, res) => {
    try {
        // 1. Parallel Fetch: Users, Registrations, and Events
        const [usersData, regsData, eventsData] = await Promise.all([
            docClient.send(new ScanCommand({ TableName: 'Lakshya_Users' })),
            docClient.send(new ScanCommand({ TableName: 'Lakshya_Registrations' })),
            docClient.send(new ScanCommand({ TableName: 'Lakshya_Events' }))
        ]);
        
        const users = usersData.Items || [];
        const regs = regsData.Items || [];
        const events = eventsData.Items || [];

        // 2. Create Event ID -> Title Map
        const eventMap = {};
        events.forEach(e => eventMap[e.eventId] = e.title);

        // 3. Map Registrations by User Email
        const regLookup = {};
        regs.forEach(r => {
            const email = r.studentEmail;
            if (!regLookup[email]) regLookup[email] = [];
            
            // Resolve Event Name (use ID if Name not found)
            const eventName = eventMap[r.eventId] || r.eventId;
            regLookup[email].push(eventName);
        });

        // 4. Enrich User Objects
        const enrichedUsers = users.map(user => {
            const { password, ...safeData } = user;
            const userRegs = regLookup[user.email] || [];
            
            return {
                ...safeData,
                regCount: userRegs.length,
                regEvents: userRegs // Array of Event Names
            };
        });

        // 5. Sort by Join Date
        enrichedUsers.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

        res.json(enrichedUsers);

    } catch (err) {
        console.error("Fetch Users Error:", err);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

app.post('/api/admin/broadcast-email', isAuthenticated('admin'), upload.array('attachments'), async (req, res) => {
    try {
        const { recipients, subject, message } = req.body;
        
        // Parse the boolean flags sent from frontend
        const isHtml = req.body.isHtml === 'true';
        const skipTemplate = req.body.skipTemplate === 'true';
        
        if (!recipients || !subject) {
            return res.status(400).json({ error: "Recipients and Subject are required." });
        }

        // 1. Handle File Uploads (Upload to S3 -> Get Links)
        let attachmentsHtml = '';
        if (req.files && req.files.length > 0) {
            // Style differently based on whether it's a raw page or template
            if (skipTemplate) {
                attachmentsHtml += `<div style="margin: 20px; padding: 15px; border-top: 1px solid #ccc; font-family: sans-serif;">
                                    <strong>📎 Attachments:</strong><br>`;
            } else {
                attachmentsHtml += `<div style="margin-top: 25px; padding-top: 20px; border-top: 1px solid #eee;">
                                    <strong style="color: #0c2d48;">📎 Attachments:</strong>`;
            }
            
            for (const file of req.files) {
                const fileExt = file.originalname.split('.').pop().toLowerCase();
                const fileName = `broadcast/${uuidv4()}-${file.originalname}`;
                
                // Upload to S3
                const uploadParams = {
                    Bucket: 'lakshya-assets-2k26-prod-12345',
                    Key: fileName,
                    Body: file.buffer,
                    ContentType: file.mimetype
                };
                await s3Client.send(new PutObjectCommand(uploadParams));
                
                const fileUrl = `https://lakshya-assets-2k26-prod-12345.s3.ap-south-1.amazonaws.com/${fileName}`;

                // Check if Image or Document
                if (['jpg', 'jpeg', 'png', 'gif'].includes(fileExt)) {
                    attachmentsHtml += `<p style="text-align:center; margin-top:15px;"><img src="${fileUrl}" alt="Attachment" style="max-width: 100%; height: auto; border-radius: 6px; border: 1px solid #ddd;"></p>`;
                } else {
                    attachmentsHtml += `<p style="margin-top:10px;">📄 <a href="${fileUrl}" target="_blank" style="color: #1f75ad; text-decoration: none; font-weight: bold;">Download ${file.originalname}</a></p>`;
                }
            }
            attachmentsHtml += `</div>`;
        }

        // 2. Construct Full Email Body based on flags
        let fullEmailBody = '';

        if (skipTemplate) {
            // OPTION A: Full Custom Page
            // User provides complete HTML. We simply append attachments at the end if they exist.
            fullEmailBody = message + (attachmentsHtml ? attachmentsHtml : '');
        } else {
            // OPTION B: Standard Template
            // Determine inner content processing
            const innerContent = isHtml 
                ? message // Inject Raw HTML
                : message.replace(/\n/g, '<br>'); // Convert newlines for plain text

            fullEmailBody = `
                <div style="background:#eff2f6;padding:20px;font-family:Arial,Helvetica,sans-serif;">
                  <div style="max-width:720px;margin:auto;background:#ffffff;padding:30px;border-radius:8px;">

                    <!-- Logo -->
                    <div style="text-align:center;margin-bottom:20px;">
                      <img src="https://res.cloudinary.com/dpz44zf0z/image/upload/v1764605760/logo_oeso2m.png" alt="LAKSHYA 2K26 Logo" style="max-width:160px;height:auto;" />
                    </div>

                    <!-- Header -->
                    <h1 style="text-align:center;color:#0c2d48;margin-bottom:5px;">LAKSHYA 2K26</h1>
                    <h3 style="text-align:center;color:#1a5f91;font-weight:normal;margin-top:0;">National Level Technical & Cultural Fest</h3>

                    <!-- Message Content -->
                    <div style="line-height:1.6;color:#333;margin-top:25px;font-size:15px;">
                       ${innerContent}
                    </div>

                    <!-- Attachments Section -->
                    ${attachmentsHtml}

                    <!-- Standard Event Info Footer -->
                    <div style="background:#f4f9ff;border-left:5px solid #1f75ad;padding:15px;margin:25px 0;">
                      <strong>✨ Event Details</strong><br>
                      📅 Date: <strong>3rd January 2026</strong><br>
                      📍 Venue: <strong>LBRCE, Mylavaram</strong>
                    </div>

                    <!-- Footer -->
                    <p style="text-align:center;color:#666;font-size:13px;margin-top:25px;border-top:1px solid #eee;padding-top:20px;">
                      Team LAKSHYA 2K26<br>
                      Lakireddy Bali Reddy College of Engineering (LBRCE)
                    </p>

                  </div>
                </div>
            `;
        }

        // 3. Send Emails (Loop through recipients)
        const emailList = recipients.split(',').map(e => e.trim()).filter(e => e);
        
        // Use Promise.all to send in parallel
        const sendPromises = emailList.map(email => sendEmail(email, subject, fullEmailBody));
        
        await Promise.all(sendPromises);

        res.json({ success: true, count: emailList.length });

    } catch (error) {
        console.error("Broadcast Error:", error);
        res.status(500).json({ error: "Failed to send emails." });
    }
});

// --- ADD TO YOUR backend.js ---

// 1. ADD Team Member
// --- REPLACE THE EXISTING 'add-team-member' ROUTE IN backend.js ---

// --- REPLACE THE EXISTING 'add-team-member' ROUTE IN backend.js ---

app.post('/api/coordinator/add-team-member', isAuthenticated('coordinator'), upload.single('image'), async (req, res) => {
    try {
        const { fullName, mobile, email, type, year, deptName, eventName, position } = req.body;
        
        // 1. Image Upload
        let imageUrl = 'assets/default-user.png'; 
        if (req.file) {
            const fileName = `team/${deptName}/${uuidv4()}-${req.file.originalname}`;
            const uploadParams = {
                Bucket: 'lakshya-assets-2k26-prod-12345', 
                Key: fileName,
                Body: req.file.buffer,
                ContentType: req.file.mimetype
            };
            await s3Client.send(new PutObjectCommand(uploadParams));
            imageUrl = `https://lakshya-assets-2k26-prod-12345.s3.ap-south-1.amazonaws.com/${fileName}`;
        }

        // 2. Save to Database
        const teamItem = {
            memberId: uuidv4(),
            deptName: deptName,
            roleType: type,
            fullName: fullName,
            mobile: mobile,
            email: email,
            year: type === 'student' ? year : 'N/A', 
            eventName: eventName,       
            position: position,          
            imageUrl: imageUrl,
            addedBy: req.session.user.email,
            createdAt: new Date().toISOString()
        };

        await docClient.send(new PutCommand({
            TableName: 'Lakshya_EventTeam',
            Item: teamItem
        }));

        // 3. SELECT EMAIL TEMPLATE BASED ON TYPE
        let emailSubject = "";
        let emailBodyContent = "";



if (type === "faculty") {
    // --- FACULTY TEMPLATE ---
    emailSubject = "Appointment as Faculty Coordinator | LAKSHYA 2K26";
    emailBodyContent = `
<table width="100%" cellpadding="0" cellspacing="0" border="0" 
       style="font-family:'Segoe UI',Tahoma,sans-serif;background:#fff;">
<tr><td align="center">

    <table width="100%" cellpadding="0" cellspacing="0" border="0"
           style="max-width:600px;width:100%;border:1px solid #e5e5e5;border-radius:12px;overflow:hidden;">

        <!-- HEADER -->
        <tr>
            <td align="center" style="background:linear-gradient(135deg,#1e3c72,#2a5298);padding:25px 15px;">
                <img src="https://res.cloudinary.com/dpz44zf0z/image/upload/v1764605760/logo_oeso2m.png"
                     style="width:42px;height:auto;margin-bottom:10px;" />

                <h1 style="color:#fff;margin:0;font-size:22px;font-weight:600;">
                    Faculty Appointment
                </h1>
                <p style="color:#dbe2ff;margin:5px 0 0;font-size:13px;">
                    LAKSHYA 2K26 • Lakireddy Bali Reddy College of Engineering
                </p>
            </td>
        </tr>

        <!-- BODY -->
        <tr>
            <td style="padding:25px 18px;color:#333;">
                
                <p style="font-size:15px;line-height:1.6;">
                    Respected <strong>${fullName}</strong>,
                </p>

                <p style="font-size:14px;line-height:1.6;color:#555;">
                    We are pleased to inform you that you have been appointed as a 
                    <strong>Faculty Coordinator</strong> for <strong>LAKSHYA 2K26</strong>.
                </p>

                <!-- ROLE CARD -->
                <table width="100%" cellpadding="0" cellspacing="0" border="0"
                       style="background:#f5f8ff;border-left:5px solid #2a5298;border-radius:6px;border:1px solid #e0e6f1;margin:20px 0;">
                <tr><td style="padding:15px;">

                    <p style="margin:0;font-size:11px;color:#666;text-transform:uppercase;font-weight:600;">
                        Designation
                    </p>
                    <p style="margin:6px 0 15px;font-size:18px;font-weight:600;color:#1e3c72;">
                        ${position}
                    </p>

                    <!-- MOBILE-SAFE TABLE -->
                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                        <td width="50%" style="padding-right:10px;vertical-align:top;">
                            <p style="margin:0;font-size:11px;text-transform:uppercase;color:#666;font-weight:600;">
                                Domain / Event
                            </p>
                            <p style="margin:4px 0 0;font-size:13px;font-weight:600;color:#333;">
                                ${eventName}
                            </p>
                        </td>

                        <td width="50%" style="padding-left:10px;vertical-align:top;">
                            <p style="margin:0;font-size:11px;text-transform:uppercase;color:#666;font-weight:600;">
                                Department
                            </p>
                            <p style="margin:4px 0 0;font-size:13px;font-weight:600;color:#333;">
                                ${deptName}
                            </p>
                        </td>
                    </tr>
                    </table>

                </td></tr>
                </table>

                <p style="font-size:14px;line-height:1.6;color:#555;">
                    Your leadership and guidance will be instrumental in making this event successful.
                    We sincerely appreciate your support.
                </p>
            </td>
        </tr>

        <!-- FOOTER -->
        <tr>
            <td align="center" style="background:#f4f6f9;padding:15px;font-size:12px;color:#777;border-top:1px solid #e5e5e5;">
                <p style="margin:0;">LAKSHYA 2K26 • Lakireddy Bali Reddy College of Engineering</p>
                <p style="margin:4px 0 10px;">This is an automated email. Please do not reply.</p>
                <p style="margin:0;">
                    Powered by <a href="https://xetasolutions.in" style="color:#1e3c72;font-weight:600;text-decoration:none;">Xeta Solutions</a>
                </p>
            </td>
        </tr>

    </table>

</td></tr>
</table>
    `;
}

else {
    // --- STUDENT TEMPLATE ---
    emailSubject = "Welcome to the Team | LAKSHYA 2K26";
    emailBodyContent = `
<table width="100%" cellpadding="0" cellspacing="0" border="0" 
       style="font-family:'Segoe UI',Tahoma,sans-serif;background:#fff;">
<tr><td align="center">

    <table width="100%" cellpadding="0" cellspacing="0" border="0"
           style="max-width:600px;width:100%;border:1px solid #eee;border-radius:12px;overflow:hidden;">

        <!-- HEADER -->
        <tr>
            <td align="center" style="background:linear-gradient(135deg,#1e3c72,#2a5298);padding:25px 15px;">
                <img src="https://res.cloudinary.com/dpz44zf0z/image/upload/v1764605760/logo_oeso2m.png"
                     style="width:38px;height:auto;margin-bottom:10px;" />

                <h1 style="color:#fff;margin:0;font-size:22px;font-weight:600;">
                    Welcome Aboard!
                </h1>
                <p style="color:#dbe2ff;margin:5px 0 0;font-size:13px;">
                    LAKSHYA 2K26 Team
                </p>
            </td>
        </tr>

        <!-- BODY -->
        <tr>
            <td style="padding:25px 18px;color:#333;">
                
                <p style="font-size:15px;line-height:1.6;">
                    Dear <strong>${fullName}</strong>,
                </p>

                <p style="font-size:14px;line-height:1.6;color:#555;">
                    Congratulations! You have been selected as a member of the organizing team for 
                    <strong>LAKSHYA 2K26</strong>.
                </p>

                <!-- ROLE CARD -->
                <table width="100%" cellpadding="0" cellspacing="0" border="0"
                       style="background:#f5f8ff;border-left:5px solid #2a5298;border-radius:6px;border:1px solid #e0e6f1;margin:20px 0;">
                <tr><td style="padding:15px;">

                    <p style="margin:0;font-size:11px;color:#666;text-transform:uppercase;font-weight:600;">
                        Your Role
                    </p>
                    <p style="margin:6px 0 15px;font-size:18px;font-weight:600;color:#1e3c72;">
                        ${position}
                    </p>

                    <!-- MOBILE FRIENDLY TABLE -->
                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                        <td width="50%" style="padding-right:10px;vertical-align:top;">
                            <p style="margin:0;font-size:11px;text-transform:uppercase;color:#666;font-weight:600;">
                                Event / Domain
                            </p>
                            <p style="margin:4px 0 0;font-size:13px;font-weight:600;color:#333;">
                                ${eventName}
                            </p>
                        </td>

                        <td width="50%" style="padding-left:10px;vertical-align:top;">
                            <p style="margin:0;font-size:11px;text-transform:uppercase;color:#666;font-weight:600;">
                                Year
                            </p>
                            <p style="margin:4px 0 0;font-size:13px;font-weight:600;color:#333;">
                                ${deptName}
                            </p>
                        </td>
                    </tr>
                    </table>

                </td></tr>
                </table>

                <p style="font-size:14px;line-height:1.6;color:#555;">
                    Get ready to collaborate, learn, and make this fest a grand success!
                </p>
            </td>
        </tr>

        <!-- FOOTER -->
        <tr>
            <td align="center" style="background:#f8f9fa;padding:15px;font-size:12px;color:#777;border-top:1px solid #eee;">
                <p style="margin:0;">LAKSHYA 2K26 • Lakireddy Bali Reddy College of Engineering</p>
                <p style="margin:5px 0 10px;">This is an automated email.</p>
                <p style="margin:0;">
                    Powered by <a href="https://xetasolutions.in" 
                    style="color:#1e3c72;font-weight:600;text-decoration:none;">Xeta Solutions</a>
                </p>
            </td>
        </tr>

    </table>

</td></tr>
</table>
    `;
}

// FINAL WRAPPER
const finalEmailHtml = `
    <div style="font-family:'Segoe UI',sans-serif;background:#ffffff;">
        ${emailBodyContent}
    </div>
`;


        // Send Email
        sendEmail(email, emailSubject, finalEmailHtml).catch(err => console.error("Email failed:", err));

        res.json({ message: 'Added successfully & Email Sent!' });

    } catch (err) {
        console.error("Add Team Error:", err);
        res.status(500).json({ error: 'Failed to add member.' });
    }
});// 2. FETCH Team List (New)
app.get('/api/coordinator/team-members', isAuthenticated('coordinator'), async (req, res) => {
    try {
        const userDept = req.session.user.dept;
        
        // Security Check
        if(!userDept) return res.status(400).json({ error: "Department not found in session" });

        // Query by Department (Efficient)
        const params = {
            TableName: 'Lakshya_EventTeam',
            KeyConditionExpression: 'deptName = :d',
            ExpressionAttributeValues: { ':d': userDept }
        };

        const data = await docClient.send(new QueryCommand(params));
        
        // Sort: Faculty first, then by Name
        const items = data.Items || [];
        items.sort((a, b) => {
            if (a.roleType !== b.roleType) return a.roleType === 'faculty' ? -1 : 1;
            return a.fullName.localeCompare(b.fullName);
        });

        res.json(items);

    } catch (err) {
        console.error("Fetch Team Error:", err);
        res.status(500).json({ error: "Failed to fetch list" });
    }
});
app.get('/api/coordinator/team-members', isAuthenticated('coordinator'), async (req, res) => {
    try {
        const userDept = req.session.user.dept;
        
        // Security Check
        if(!userDept) return res.status(400).json({ error: "Department not found in session" });

        // Query by Department (Efficient)
        const params = {
            TableName: 'Lakshya_EventTeam',
            KeyConditionExpression: 'deptName = :d',
            ExpressionAttributeValues: { ':d': userDept }
        };

        const data = await docClient.send(new QueryCommand(params));
        
        // Sort: Faculty first, then by Name
        const items = data.Items || [];
        items.sort((a, b) => {
            if (a.roleType !== b.roleType) return a.roleType === 'faculty' ? -1 : 1;
            return a.fullName.localeCompare(b.fullName);
        });

        res.json(items);

    } catch (err) {
        console.error("Fetch Team Error:", err);
        res.status(500).json({ error: "Failed to fetch list" });
    }
});

// 3. DELETE Team Member (New)
app.delete('/api/coordinator/delete-team-member', isAuthenticated('coordinator'), async (req, res) => {
    try {
        const { memberId, deptName } = req.body;
        
        // Verify dept to prevent deleting others
        if (deptName !== req.session.user.dept) {
            return res.status(403).json({ error: "Unauthorized" });
        }

        const params = {
            TableName: 'Lakshya_EventTeam',
            Key: {
                deptName: deptName, // Partition Key
                memberId: memberId  // Sort Key
            }
        };

        await docClient.send(new DeleteCommand(params));
        res.json({ message: 'Deleted successfully' });

    } catch (err) {
        console.error("Delete Team Error:", err);
        res.status(500).json({ error: "Failed to delete" });
    }
});

// 4. UPDATE Team Member (New)
app.put('/api/coordinator/update-team-member', isAuthenticated('coordinator'), upload.single('image'), async (req, res) => {
    try {
        const { memberId, deptName, fullName, mobile, email, type, year, eventName, position, existingImageUrl } = req.body;

        if (deptName !== req.session.user.dept) {
            return res.status(403).json({ error: "Unauthorized" });
        }

        // Handle Image Logic
        let imageUrl = existingImageUrl;
        if (req.file) {
            const fileName = `team/${deptName}/${uuidv4()}-${req.file.originalname}`;
            const uploadParams = {
                Bucket: 'lakshya-assets-2k26-prod-12345', 
                Key: fileName,
                Body: req.file.buffer,
                ContentType: req.file.mimetype
            };
            await s3Client.send(new PutObjectCommand(uploadParams));
            imageUrl = `https://lakshya-assets-2k26-prod-12345.s3.ap-south-1.amazonaws.com/${fileName}`;
        }

        const params = {
            TableName: 'Lakshya_EventTeam',
            Key: { deptName, memberId },
            UpdateExpression: "set fullName=:n, mobile=:m, email=:e, roleType=:t, #yr=:y, eventName=:ev, position=:p, imageUrl=:img",
            ExpressionAttributeValues: {
                ':n': fullName,
                ':m': mobile,
                ':e': email,
                ':t': type,
                ':y': type === 'student' ? year : 'N/A',
                ':ev': eventName,
                ':p': position,
                ':img': imageUrl
            },
            ExpressionAttributeNames: { "#yr": "year" } // Year is reserved
        };

        await docClient.send(new UpdateCommand(params));
        res.json({ message: 'Updated successfully' });

    } catch (err) {
        console.error("Update Team Error:", err);
        res.status(500).json({ error: "Failed to update" });
    }
});

app.get('/api/admin/all-team-members', isAuthenticated('admin'), async (req, res) => {
    try {
        // Scans the entire table (Admin needs global view)
        const data = await docClient.send(new ScanCommand({ 
            TableName: 'Lakshya_EventTeam' 
        }));
        
        // Sort by Department, then Role (Faculty first), then Name
        const items = data.Items || [];
        items.sort((a, b) => {
            if (a.deptName !== b.deptName) return a.deptName.localeCompare(b.deptName);
            if (a.roleType !== b.roleType) return a.roleType === 'faculty' ? -1 : 1;
            return a.fullName.localeCompare(b.fullName);
        });

        res.json(items);
    } catch (err) {
        console.error("Admin Fetch Team Error:", err);
        res.status(500).json({ error: "Failed to fetch team data" });
    }
});

///////////////////////////////////// FOOD COUPON

app.get('/stall/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/stall/login.html'));
});

// Serve the Stall Dashboard (Protected)
app.get('/stall/dashboard', isAuthenticated('stall'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/stall/dashboard.html'));
});

// --- COUPON PAGE ROUTE ---
// Ensure this matches where you actually saved the file
// app.get('/my-coupons', isAuthenticated('participant'), (req, res) => {
//     // If you saved it in public/static:
//     res.sendFile(path.join(__dirname, 'public/static/my-coupons.html'));
// });

// --- ADMIN STATS ROUTE ---
app.get('/admin/coupon-stats', isAuthenticated('admin'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/admin-coupon-stats.html'));
});
// ... existing code ...
app.get('/admin/manage-stalls', isAuthenticated('admin'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/manage-stalls.html'));
});


// =============================================================
// --- FOOD COUPON SYSTEM ENDPOINTS ---
// =============================================================

// 1. STALL AUTHENTICATION
// Simple hardcoded login for stalls (easier than managing a user DB for them)
app.get('/api/admin/stalls', isAuthenticated('admin'), async (req, res) => {
    try {
        const data = await docClient.send(new ScanCommand({ TableName: 'Lakshya_StallUsers' }));
        res.json(data.Items || []);
    } catch (e) {
        res.status(500).json({ error: 'Failed to load stalls' });
    }
});

// 2. CREATE STALL
app.post('/api/admin/create-stall', isAuthenticated('admin'), async (req, res) => {
    const { stallName, accessCode } = req.body;
    
    // Check if exists
    // (Ideally use ConditionExpression, but simple check is okay here)
    const check = await docClient.send(new GetCommand({ TableName: 'Lakshya_StallUsers', Key: { stallId: stallName } }));
    if(check.Item) return res.status(400).json({ error: "Stall Name already exists" });

    try {
        await docClient.send(new PutCommand({
            TableName: 'Lakshya_StallUsers',
            Item: {
                stallId: stallName, // PK
                stallName: stallName,
                accessCode: accessCode,
                createdAt: new Date().toISOString()
            }
        }));
        res.json({ message: 'Created' });
    } catch (e) {
        res.status(500).json({ error: 'Creation Failed' });
    }
});

// 3. DELETE STALL
app.post('/api/admin/delete-stall', isAuthenticated('admin'), async (req, res) => {
    try {
        await docClient.send(new DeleteCommand({
            TableName: 'Lakshya_StallUsers',
            Key: { stallId: req.body.stallId }
        }));
        res.json({ message: 'Deleted' });
    } catch (e) {
        res.status(500).json({ error: 'Deletion Failed' });
    }
});

// ==========================================
// --- UPDATED STALL LOGIN (DYNAMIC) ---
// ==========================================
// REPLACE your old 'api/auth/stall-login' with this one:

app.post('/api/auth/stall-login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        const data = await docClient.send(new GetCommand({ 
            TableName: 'Lakshya_StallUsers', 
            Key: { stallId: username } 
        }));
        
        const stall = data.Item;
        
        if (stall && stall.accessCode === password) {
            req.session.user = { 
                email: stall.stallId, 
                role: 'stall', 
                name: stall.stallName 
            };
            return res.json({ message: 'Login success' });
        }
        res.status(401).json({ error: 'Invalid Stall ID or Access Code' });
    } catch(e) {
        console.error("Stall Login Error:", e);
        res.status(500).json({ error: 'Server Error' });
    }
});

app.get('/api/public/coupons/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const params = {
            TableName: 'Lakshya_FoodCoupons',
            FilterExpression: '#src = :s',
            ExpressionAttributeNames: { '#src': 'source' },
            ExpressionAttributeValues: { ':s': id }
        };
        const data = await docClient.send(new ScanCommand(params));
        res.json(data.Items || []);
    } catch (e) {
        console.error("Public Coupon Fetch Error:", e);
        res.status(500).json({ error: 'Failed to fetch coupons' });
    }
});
// 2. STALL DASHBOARD STATS
app.get('/api/stall/stats', isAuthenticated('stall'), async (req, res) => {
    const stallId = req.session.user.name;
    const todayStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    try {
        // Count total redeemed by this stall
        // Note: For high scale, use a secondary index. For now, Scan is okay.
        const params = {
            TableName: 'Lakshya_FoodCoupons',
            FilterExpression: 'redeemedBy = :stall',
            ExpressionAttributeValues: { ':stall': stallId }
        };
        const data = await docClient.send(new ScanCommand(params));
        const count = data.Count || 0;

        res.json({ stallName: stallId, scannedCount: count });
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// 3. REDEEM COUPON (The Scanner Logic)
app.post('/api/stall/redeem', isAuthenticated('stall'), async (req, res) => {
    const { qrCode } = req.body;
    const stallId = req.session.user.name;

    try {
        // A. Check if Coupon Exists
        const getRes = await docClient.send(new GetCommand({
            TableName: 'Lakshya_FoodCoupons',
            Key: { code: qrCode }
        }));

        const coupon = getRes.Item;

        if (!coupon) {
            return res.status(404).json({ error: 'Invalid Coupon Code' });
        }

        // B. Check if Already Used
        if (coupon.status === 'REDEEMED') {
            return res.status(400).json({ error: `Already used by ${coupon.holderName} at ${coupon.redeemedBy || 'another stall'}` });
        }

        // C. Atomic Update to Redeem
        await docClient.send(new UpdateCommand({
            TableName: 'Lakshya_FoodCoupons',
            Key: { code: qrCode },
            UpdateExpression: "set #s = :newStatus, redeemedBy = :stall, redeemedAt = :time",
            ConditionExpression: "#s = :oldStatus", // Prevents double scanning race condition
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
                ":newStatus": "REDEEMED",
                ":oldStatus": "ACTIVE",
                ":stall": stallId,
                ":time": new Date().toISOString()
            }
        }));

        res.json({ message: 'Redeemed Successfully', student: coupon.holderName });

    } catch (e) {
        console.error("Redeem Error:", e);
        if (e.name === 'ConditionalCheckFailedException') {
            return res.status(400).json({ error: 'Coupon was just redeemed by someone else.' });
        }
        res.status(500).json({ error: 'Redemption Failed' });
    }
});

// 4. FETCH MY COUPONS (For Students & Coordinators)
app.get('/api/participant/my-coupons', isAuthenticated('participant'), async (req, res) => {
    try {
        const email = req.session.user.email;
        const params = {
            TableName: 'Lakshya_FoodCoupons',
            FilterExpression: 'holderEmail = :e',
            ExpressionAttributeValues: { ':e': email }
        };
        const data = await docClient.send(new ScanCommand(params));
        res.json(data.Items || []);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch coupons' });
    }
});

// 5. ADMIN ANALYTICS
app.get('/api/admin/coupon-analytics', isAuthenticated('admin'), async (req, res) => {
    try {
        const data = await docClient.send(new ScanCommand({ TableName: 'Lakshya_FoodCoupons' }));
        const coupons = data.Items || [];

        const totalIssued = coupons.length;
        const totalRedeemed = coupons.filter(c => c.status === 'REDEEMED').length;

        // Group by Stall
        const stallStats = {};
        coupons.forEach(c => {
            if (c.status === 'REDEEMED' && c.redeemedBy) {
                stallStats[c.redeemedBy] = (stallStats[c.redeemedBy] || 0) + 1;
            }
        });

        const stallsArray = Object.keys(stallStats).map(key => ({
            id: key, name: key, count: stallStats[key], lastActive: new Date().toISOString()
        }));

        res.json({
            totalIssued,
            totalRedeemed,
            stalls: stallsArray,
            // Mock data for charts if needed
            hourlyStats: { labels: [], values: [] }, 
            deptStats: []
        });
    } catch (e) {
        res.status(500).json({ error: 'Stats failed' });
    }
});

// 6. ISSUE COUPONS TO STUDENT COORDINATORS (Bulk Action)
app.post('/api/admin/issue-team-coupons', isAuthenticated('admin'), async (req, res) => {
    try {
        // A. Fetch all Student Team Members
        const teamRes = await docClient.send(new ScanCommand({
            TableName: 'Lakshya_EventTeam',
            FilterExpression: 'roleType = :r',
            ExpressionAttributeValues: { ':r': 'student' }
        }));
        
        const students = teamRes.Items || [];
        let count = 0;

        // B. Generate Coupons for each (if they don't have them)
        for (const s of students) {
            // Check if coupons already exist for this email to prevent duplicates
            const checkRes = await docClient.send(new ScanCommand({
                TableName: 'Lakshya_FoodCoupons',
                FilterExpression: 'holderEmail = :e',
                ExpressionAttributeValues: { ':e': s.email }
            }));

            if (checkRes.Count === 0) {
                // Issue 2 Coupons
                await generateCouponsForUser(s.email, s.fullName, "TEAM_MEMBER");
                count++;
            }
        }

        res.json({ message: `Issued coupons to ${count} new student coordinators.` });

    } catch (e) {
        console.error("Team Issue Error:", e);
        res.status(500).json({ error: 'Failed to issue team coupons' });
    }
});

// HELPER: Generate 2 Coupons
app.get('/api/admin/team-coupon-stats', isAuthenticated('admin'), async (req, res) => {
    try {
        // A. Fetch All Student Coordinators
        const teamData = await docClient.send(new ScanCommand({
            TableName: 'Lakshya_EventTeam',
            FilterExpression: 'roleType = :r',
            ExpressionAttributeValues: { ':r': 'student' }
        }));
        const students = teamData.Items || [];

        // B. Fetch All Issued Coupons (to map who has one)
        const couponData = await docClient.send(new ScanCommand({
            TableName: 'Lakshya_FoodCoupons'
        }));
        // Create a Set of emails that ALREADY have coupons
        const issuedEmails = new Set((couponData.Items || []).map(c => c.holderEmail));

        // C. Aggregate Data
        const stats = {};
        
        students.forEach(s => {
            const dept = s.deptName || 'General';
            
            if (!stats[dept]) {
                stats[dept] = { deptName: dept, totalMembers: 0, issuedCount: 0 };
            }
            
            stats[dept].totalMembers++;
            
            if (issuedEmails.has(s.email)) {
                stats[dept].issuedCount++;
            }
        });

        res.json(Object.values(stats));

    } catch (e) {
        console.error("Stats Error:", e);
        res.status(500).json({ error: "Failed to fetch stats" });
    }
});

// 2. Get List: Fetch Coordinators of a specific Department with Status
app.get('/api/admin/department-coordinators', isAuthenticated('admin'), async (req, res) => {
    const { deptName } = req.query;
    if (!deptName) return res.status(400).json({ error: "Department is required" });

    try {
        // A. Query Team Members by Dept (Partition Key: deptName)
        const teamData = await docClient.send(new QueryCommand({
            TableName: 'Lakshya_EventTeam',
            KeyConditionExpression: 'deptName = :d',
            ExpressionAttributeValues: { ':d': deptName }
        }));
        
        // Filter for students only
        const members = (teamData.Items || []).filter(m => m.roleType === 'student');

        // B. Check Status for each member
        // (Parallel check is faster than sequential)
        const membersWithStatus = await Promise.all(members.map(async (m) => {
            // Check if this specific email has coupons
            const couponCheck = await docClient.send(new ScanCommand({
                TableName: 'Lakshya_FoodCoupons',
                FilterExpression: 'holderEmail = :e',
                ExpressionAttributeValues: { ':e': m.email }
            }));
            
            return {
                memberId: m.memberId,
                fullName: m.fullName,
                email: m.email,
                mobile: m.mobile,
                hasCoupons: couponCheck.Count > 0 // True if they have coupons
            };
        }));

        res.json(membersWithStatus);

    } catch (e) {
        console.error("Dept Coord Error:", e);
        res.status(500).json({ error: "Failed to fetch list" });
    }
});

// 3. Action: Issue Coupons to Selected List
// 3. Action: Issue Coupons to Selected List (WITH EMAIL SENDING)
app.post('/api/admin/issue-selected-coupons', isAuthenticated('admin'), async (req, res) => {
    const { recipients } = req.body; 
    
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
        return res.status(400).json({ error: "No recipients selected" });
    }

    try {
        let successCount = 0;
        let resentCount = 0;

        for (const user of recipients) {
            // A. Check if coupons already exist
            const check = await docClient.send(new ScanCommand({
                TableName: 'Lakshya_FoodCoupons',
                FilterExpression: 'holderEmail = :e',
                ExpressionAttributeValues: { ':e': user.email }
            }));

            let couponsToSend = [];

            if (check.Count === 0) {
                // CASE 1: NEW USER - Generate 2 Coupons
                await generateCouponsForUser(user.email, user.name || "Coordinator", "TEAM_MEMBER");
                
                // Fetch them back immediately to send email
                const newCoupons = await docClient.send(new ScanCommand({
                    TableName: 'Lakshya_FoodCoupons',
                    FilterExpression: 'holderEmail = :e',
                    ExpressionAttributeValues: { ':e': user.email }
                }));
                couponsToSend = newCoupons.Items || [];
                successCount++;
            } else {
                // CASE 2: EXISTING USER - Just Resend Email
                couponsToSend = check.Items;
                resentCount++;
            }

            // B. SEND EMAIL (Crucial Step)
            if (couponsToSend.length > 0) {
                // Use the FIRST coupon's source ID (usually "TEAM_MEMBER") for the link
                const linkId = couponsToSend[0].source; 

                const emailSubject = "Your Food Coupons are Here! 🍔 | LAKSHYA 2K26";
                const emailHtml = `
                <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; background-color: #ffffff; border-radius: 8px; overflow: hidden;">
                    <div style="background: linear-gradient(135deg, #00d2ff, #3a7bd5); padding: 20px; text-align: center;">
                         <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: bold;">LAKSHYA 2K26</h1>
                         <p style="color: #eafaff; margin: 5px 0 0; font-size: 14px;">Team Refreshments</p>
                    </div>
                    <div style="padding: 30px;">
                        <p style="font-size: 16px; color: #333;">Hello <strong>${user.name}</strong>,</p>
                        <p style="font-size: 15px; color: #555;">Thank you for your hard work as a Student Coordinator! Here are your food coupons.</p>
                        
                        <div style="background-color: #f0fbff; border: 1px dashed #00d2ff; padding: 20px; border-radius: 8px; margin: 25px 0; text-align: center;">
                            <h3 style="color: #0077ff; margin: 0 0 10px 0;">🍔 Food Coupons Ready</h3>
                            <div style="margin-top: 15px;">
                                <a href="http://localhost:3000/my-coupons?id=${linkId}" 
                                   style="background-color: #ff00cc; color: white; padding: 12px 25px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 14px; display: inline-block;">
                                   View My QR Codes
                                </a>
                            </div>
                        </div>
                        <p style="font-size: 13px; color: #888;">Click the button above to show your QR codes at the stalls.</p>
                    </div>
                </div>`;
                
                await sendEmail(user.email, emailSubject, emailHtml);
            }
        }

        res.json({ 
            message: `Processed: ${successCount} Generated, ${resentCount} Resent.`, 
            success: true 
        });

    } catch (e) {
        console.error("Issue Error:", e);
        res.status(500).json({ error: "Failed to issue/send coupons" });
    }
});
// --- ADMIN STATS ROUTE ---
app.get('/admin/coupon-stats', isAuthenticated('admin'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/admin-coupon-stats.html'));
});
app.get('/admin/issue-coupon', isAuthenticated('admin'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin/issue-coupons.html'));
});

app.get('/coordinator/register-participant', isAuthenticated('coordinator'), (req, res) => {
    res.sendFile(path.join(__dirname, 'public/coordinator/on-site-reg.html'));
});

// 2. API: Search Participant & Calculate History-Based Discount Eligibility
app.get('/api/coordinator/search-participant', isAuthenticated('coordinator'), async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "Email is required" });

    try {
        // Step A: Fetch User Profile
        const userRes = await docClient.send(new GetCommand({
            TableName: 'Lakshya_Users',
            Key: { email: email.toLowerCase().trim() }
        }));

        if (!userRes.Item) {
            return res.status(404).json({ error: "Student account not found. Please ask them to register on the website first." });
        }

        const student = userRes.Item;
        delete student.password; // Security

        // Step B: Calculate History of Paid Eligible Events (Major, MBA, Cultural)
        const regRes = await docClient.send(new QueryCommand({
            TableName: 'Lakshya_Registrations',
            IndexName: 'StudentIndex',
            KeyConditionExpression: 'studentEmail = :email',
            ExpressionAttributeValues: { ':email': email.toLowerCase().trim() }
        }));

        const registrations = regRes.Items || [];
        let historyCount = 0;

        for (const reg of registrations) {
            if (reg.paymentStatus === 'COMPLETED') {
                // Determine if the past event was an eligible category
                const cat = (reg.category || '').toLowerCase();
                const eligibleKeywords = ['major', 'mba', 'management', 'cultural', 'music', 'dance', 'singing', 'drama', 'art', 'fashion', 'literary'];
                const isEligible = eligibleKeywords.some(k => cat.includes(k)) && !cat.includes('special');
                
                if (isEligible) historyCount++;
            }
        }

        res.json({
            student,
            historyCount,
            registrations // Send full history so coordinator can see what they already joined
        });

    } catch (error) {
        console.error("Search Participant Error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// 3. API: Process Cash Registration with Server-Side Pricing Logic
app.post('/api/coordinator/on-site-register', isAuthenticated('coordinator'), async (req, res) => {
    const { 
        studentEmail, 
        eventId, 
        deptName, 
        teamName, 
        teamMembers, 
        historyCount,
        submissionTitle,
        submissionAbstract,
        submissionUrl
    } = req.body;

    try {
        // 1. Fetch Event Details for Price Verification
        const eventRes = await docClient.send(new GetCommand({
            TableName: 'Lakshya_Events',
            Key: { eventId }
        }));

        if (!eventRes.Item) return res.status(404).json({ error: "Event not found" });
        const event = eventRes.Item;
        const baseFee = parseInt(event.fee);

        // 2. Pricing Logic (Server-Side Enforcement)
        let finalAmount = baseFee;
        const isEligible = isEligibleForCombo(event);

        // If student has history OR this is not their first registration in this session, 50% off
        if (isEligible && parseInt(historyCount) >= 1) {
            finalAmount = baseFee / 2;
        }

        // 3. Check for Duplicate Registration
        const checkParams = {
            TableName: 'Lakshya_Registrations',
            IndexName: 'StudentIndex',
            KeyConditionExpression: 'studentEmail = :email',
            FilterExpression: 'eventId = :eid AND deptName = :dept',
            ExpressionAttributeValues: { 
                ':email': studentEmail.toLowerCase(), 
                ':eid': eventId, 
                ':dept': deptName 
            }
        };
        const existing = await docClient.send(new QueryCommand(checkParams));
        if (existing.Items && existing.Items.some(r => r.paymentStatus === 'COMPLETED')) {
            return res.status(400).json({ error: "Student is already registered and paid for this event." });
        }

        // 4. Create Registration Object
        const registrationId = uuidv4();
        const regItem = {
            registrationId,
            studentEmail: studentEmail.toLowerCase(),
            eventId,
            deptName,
            category: event.type,
            kitAllocated: checkKitEligibility(event.type),
            teamName: teamName || null,
            teamMembers: teamMembers || [],
            paymentStatus: "COMPLETED", // Immediate confirmation
            paymentId: `CASH-${uuidv4().substring(0,8).toUpperCase()}`,
            paymentMode: "CASH",
            paymentDate: new Date().toISOString(),
            amountPaid: finalAmount,
            registeredAt: new Date().toISOString(),
            attendance: false,
            submissionTitle: submissionTitle || null,
            submissionAbstract: submissionAbstract || null,
            submissionUrl: submissionUrl || null,
            managedBy: req.session.user.email // Track which coordinator did the reg
        };

        await docClient.send(new PutCommand({
            TableName: 'Lakshya_Registrations',
            Item: regItem
        }));

        // 5. Send Email Confirmation
        const logoUrl = "https://res.cloudinary.com/dpz44zf0z/image/upload/v1764605760/logo_oeso2m.png";
        const emailHtml = `
            <div style="font-family: 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eee;">
                <div style="background-color: #00d2ff; padding: 20px; text-align: center; color: white;">
                    <img src="${logoUrl}" style="height: 50px; margin-bottom: 10px;">
                    <h2 style="margin: 0;">CASH RECEIPT & REGISTRATION</h2>
                </div>
                <div style="padding: 30px;">
                    <p>Dear Participant,</p>
                    <p>Your on-site registration for <strong>${event.title}</strong> was successful.</p>
                    
                    <div style="background-color: #f9f9f9; padding: 20px; border-radius: 8px; margin: 20px 0;">
                        <p><strong>Registration ID:</strong> ${registrationId}</p>
                        <p><strong>Amount Received:</strong> ₹${finalAmount}</p>
                        <p><strong>Payment Mode:</strong> CASH (Collected by Coordinator)</p>
                        <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
                    </div>

                    <p style="font-size: 14px; color: #666;">Please show your Registration ID at the event venue for attendance.</p>
                    <p>Best Regards,<br>Team LAKSHYA</p>
                </div>
            </div>
        `;

        await sendEmail(studentEmail, `Registration Confirmed: ${event.title}`, emailHtml);

        res.json({ 
            success: true, 
            message: "Registration completed successfully.",
            registrationId,
            amountPaid: finalAmount
        });

    } catch (error) {
        console.error("On-Site Reg Error:", error);
        res.status(500).json({ error: "Failed to process registration" });
    }
});
// ELB Health Check - Crucial for Auto Scaling
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});
// ... existing code ...
const PORT = process.env.PORT || 3000;
if (require.main === module) {
    // CHANGE THIS BLOCK
    const server = app.listen(PORT, () => { 
        console.log(`Server running on http://localhost:${PORT}`); 
    });

    // CRITICAL: Set timeout to 10 minutes (600000ms) for 100MB files
    server.setTimeout(600000);
}

module.exports = app;
