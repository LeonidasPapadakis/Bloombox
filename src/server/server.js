const path = require('path');
const http = require('http');
const crypto = require('crypto');
const session = require('express-session');
const {rateLimit, ipKeyGenerator} = require('express-rate-limit');

// Fetching from secrets.env 
require('dotenv').config({ path: path.join(__dirname, '../../secrets.env') });

const Database = require('better-sqlite3');

// Modules required for verification
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const resend = new Resend(process.env.resendApiKey);

// Url that will be sent for email verifications. Please change to an actual domain 
const url = 'http://localhost:3000'

// Don't worry, if a db file already exists it won't create a new one or reset the existing one. :)
const db = new Database('bloombox.db')

// Enable write ahead logging to allow simultaneous write access.
db.pragma('journal_mode = WAL');

// If this port is taken change this number to a port that is not taken.
const port = 3000;

// Module for password Hashing
const bcrypt = require('bcrypt');
const saltRounds = 10;

// Express for handling http requests
const express = require('express');
const { emitWarning } = require('process');

// Hashing function.
async function hashPassword(submittedPassword, saltRounds) {
    try {
        const hash = await bcrypt.hash(submittedPassword, saltRounds);
        return hash;
    } catch (err) {
        console.error(err);
    }
}

// Prevents a crash if an sqlite search returns an error
function safeQuery(fn, fallback) {
    try {
        return fn();
    } catch {
        return fallback;
    }
}

// Function to add an action to logs db.
function logAction(userEmail, cat, trig, title, detail) {
    const time = new Date().toISOString().slice(0, 19).replace('T', ' ')
    db.prepare('INSERT INTO userLogs (userEmail, cat, trig, title, detail, time) VALUES (?, ?, ?, ?, ?, ?)').run(userEmail, cat, trig, title, detail, time);
}

// Webserver
const app = express()

// Configure session.
app.use(session({
    secret: process.env.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // We change it to true when we start using Https
        maxAge: 1000 * 60 * 60 * 24
    }
}))


app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/vendor/chart.js', express.static(path.join(__dirname, '../../node_modules/chart.js/dist')));
app.use('/vendor/marked', express.static(path.join(__dirname, '../../node_modules/marked/lib')));
console.log(path.join(__dirname, '../public'));

app.listen(port, () => {
    console.log(`Server is online! and listening on port ${port} c:`)
})


// Adding rate limits

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyGenerator: (req) => req.body.userLoginEmail || ipKeyGenerator(req),
    message: {error: "Too many login attempts. Please try again in 15 minutes"}
})

const twoFactorLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 3,
    keyGenerator: (req) => req.body.userLoginEmail || ipKeyGenerator(req),
    message: { error: "Too many code requests. Please wait before requesting another code."}
})

const forgotPasswordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3,
    keyGenerator: (req) => req.body.userLoginEmail || ipKeyGenerator(req),
    message: { error: "Too many password reset requests, please try again later."}
})

const requestDataLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 1,
    keyGenerator: (req) => req.session.user.userEmail|| ipKeyGenerator(req),
    message: { error: "Please wait till requesting again."}
})

// Function to protect routes.
function requireLogin(req, res, next) {
    if (!req.session.user) {
        return res.status(401).json({ error: "You must be logged in." });
    }
    next();
}

// Fetching the user input from registration forms.
app.post('/register', async (req, res) => {
    const { userName, userEmail, userPassword, userConfirmPassword } = req.body;
    console.log(userName, userEmail, userPassword, userConfirmPassword)

    // Server side input validation.
    if (!userName || !userEmail || !userPassword) {
        return res.status(400).json({ error: "All fields are required." });
    }

    // Server side password validation
    if (userPassword.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters." })
    }

    // Server side input sanitisation.
    if (!/^[a-zA-Z0-9_]+$/.test(userName)) {
        return res.status(400).json({ error: "Invalid username format." });
    }

    // Checking if an existing email exists.
    const emailCheck = db.prepare('SELECT userEmail FROM userInfo WHERE userEmail = ?').get(userEmail);

    // Send error if we found an existing account.
    if (emailCheck) {
        return res.status(400).json({ error: "An account with this email already exists." })
    }

    // Converting from plain text to hashed password.    
    const hashedPassword = await hashPassword(userPassword, saltRounds);

    // Adding user details to the database.
    db.prepare('INSERT INTO userInfo (userName, userEmail, hashedPassword, isVerified) VALUES (?, ?, ?, ?)').run(userName, userEmail, hashedPassword, 0);

    // Generating a JWT verification token
    const token = jwt.sign({ email: userEmail }, process.env.JWTSecret, { expiresIn: '1h' });

    // Sending verification email
    const { data, error } = await resend.emails.send({
        from: 'Bloombox <bloombox@mathusanp.com>',
        to: userEmail,
        subject: 'Verify your bloombox account.',
        headers: {
            'X-Entity-Ref-ID': crypto.randomUUID()
        },
        html: `
        <h2> Welcome to BloomBox, ${userName}! </h2>
        <p> Click the link to verify your account. Please note that the link expires in 1 hour. </p>
        <a href="${url}/verify?token=${token}">Verify my account</a>`

    })

    console.log('Resend data:', data);
    console.log('Resend error:', error);

    res.status(200).json({ message: "Account created! Please check your email to verify" })
})

// Route to handle verification requests.
app.get('/verify', (req, res) => {
    const { token } = req.query;

    try {
        const decoded = jwt.verify(token, process.env.JWTSecret);
        // Find user that sent the request and confirm verification.
        db.prepare('UPDATE userInfo SET isVerified = 1 WHERE userEmail = ?').run(decoded.email)

        res.redirect('/login.html');
    } catch (err) {
        res.status(400).json({ error: "Verification link is invalid or has expired." })
    }
})

// Route to handle login requests.
app.post('/login', loginLimiter,  async (req, res) => {
    const { userLoginEmail, userLoginPassword } = req.body;
    console.log(userLoginEmail, userLoginPassword);

    // Fetch user details from requested email.
    const user = db.prepare('SELECT userEmail, userName, hashedPassword, isVerified FROM userInfo WHERE userEmail = ?').get(userLoginEmail);
    if (!user) {
        return res.status(400).json({ error: "Credentials not recognised." })
    }
    if (user.isVerified === 0) {
        return res.status(400).json({ error: "Please check your emails for a verification email. Check your spam/junk." })
    }

    // Compare request password to stored hash using bcrypt.
    const isMatch = await bcrypt.compare(userLoginPassword, user.hashedPassword);
    

    if (!isMatch) {
        return res.status(400).json({ error: "Credentials not recognised." })
    }

    // Checking if user has two factor turned on.
    const twoFactor = db.prepare('SELECT * FROM twoFactor where userEmail = ?').get(user.userEmail)

    // Sending code if it is turned on 

    if(twoFactor) {
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expiry = Date.now() + 10 * 60 * 1000;

        db.prepare('UPDATE twoFactor SET code = ?, codeExpiry = ? WHERE userEmail = ?').run(code, expiry, user.userEmail);

        await resend.emails.send({
        from: 'Bloombox <bloombox@mathusanp.com>',
        to: user.userEmail,
        subject: 'Your Bloombox login code',
        html: `<h2>Your login code is: <strong>${code}</strong></h2><p>This code expires in 10 minutes.</p>`
    });


    req.session.pendingEmail = user.userEmail;
    return res.status(200).json({ requiresTwoFactor: true });
    }

    req.session.user = {
        userName: user.userName,
        userEmail: user.userEmail
    };

    logAction(user.userEmail, 'settings', 'manual', 'Logged in', 'Successful login');
    res.status(200).json({ message: "Login successful!", userName: user.userName });
});


// Route to handle requests related to dashboard.
app.get('/dashboard', requireLogin, (req, res) => {
    res.json({ message: `Welcome ${req.session.user.userName}` });
});

// Logout route
app.post('/logout', (req, res) => {
    // Remove session data from browser
    req.session.destroy();
    logAction(email, 'settings', 'manual', 'Logged out', 'User logged out');
    res.status(200).json({ message: "Logged out successfully." });
})

// Sesion handler
app.get('/session', (req, res) => {
    if (req.session.user) {
        res.status(200).json({ user: req.session.user });
    } else {
        res.status(200).json({ user: null });
    }
});


// Forwards /camera to the Pi's Flask service on loopback 
app.use('/camera', (req, res) => {
    const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: 5000,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: '127.0.0.1:5000' },
    }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
        console.error('Camera proxy error:', err.message);
        if (!res.headersSent) res.status(502).send('Camera service unavailable');
    });
    req.pipe(proxyReq);
});

// Get the arduino configuration table
app.get('/arduinoConfig', (req, res) => {
    try {
        const rows = db.prepare('SELECT * FROM arduinoConfig').all();
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Update arduino configuration setting
app.put('/arduinoConfig/:setting/:systemId', (req, res) => {
    const { setting, systemId } = req.params;
    const { value } = req.body;
    try {
        db.prepare(
            'INSERT INTO arduinoConfig (setting, value, systemId) VALUES (?, ?, ?) ON CONFLICT(setting, systemId) DO UPDATE SET value = excluded.value'
        ).run(setting, value, systemId);
        logAction(req.session.user?.userEmail, 'settings', 'manual', 'Arduino config updated', `Setting "${setting}" updated for system ${systemId}`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Delete a row from the arduinoConfig table
app.delete('/arduinoConfig/:setting/:systemId', (req, res) => {
    const { setting, systemId } = req.params;
    try {
        db.prepare('DELETE FROM arduinoConfig WHERE setting = ? AND systemId = ?').run(setting, systemId);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get the pi configuration table
app.get('/piConfig', (req, res) => {
    try {
        const rows = db.prepare('SELECT * FROM piConfig').all();
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Update pi configuration setting
app.put('/piConfig/:setting', (req, res) => {
    const { setting } = req.params;
    const { value } = req.body;
    try {
        db.prepare(
            'INSERT INTO piConfig (setting, value) VALUES (?, ?) ON CONFLICT(setting) DO UPDATE SET value = excluded.value'
        ).run(setting, value);
        logAction(req.session.user?.userEmail, 'settings', 'manual', 'Pi config updated', `Setting "${setting}" updated`);

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get the waterSchedule table
app.get('/waterSchedule', (req, res) => {
    try {
        const rows = db.prepare('SELECT rowid, * FROM waterSchedule').all();
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Add a new row to the waterSchedule table
app.post('/waterSchedule', (req, res) => {
    const { time, systemId, amount } = req.body;
    try {
        const result = db.prepare(
            'INSERT INTO waterSchedule (time, systemId, amount) VALUES (?, ?, ?)'
        ).run(time, systemId, amount);
        res.json({ success: true, rowid: result.lastInsertRowid });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Update a row in the waterSchedule table
app.put('/waterSchedule/:rowid', (req, res) => {
    const { rowid } = req.params;
    const { time, systemId, amount } = req.body;
    try {
        db.prepare(
            'UPDATE waterSchedule SET time = ?, systemId = ?, amount = ? WHERE rowid = ?'
        ).run(time, systemId, amount, rowid);
        logAction(req.session.user.userEmail, 'watering', 'manual', 'Schedule entry added', `New schedule: ${time} — System ${systemId} — ${amount}s`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Delete a row from the waterSchedule table
app.delete('/waterSchedule/:rowid', (req, res) => {
    const { rowid } = req.params;
    try {
        db.prepare('DELETE FROM waterSchedule WHERE rowid = ?').run(rowid);
        logAction(req.session.user.userEmail, 'watering', 'manual', 'Schedule entry removed', `Removed schedule rowid ${rowid}`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Route for when user clicks on forget password
app.post('/forgotPassword', forgotPasswordLimiter, async (req, res) => {
    const { requestEmail } = req.body;
    console.log(`User ${requestEmail} wants to reset their password, checking..`);

    try {
        // Checking if the account exists by searching for the request email.
        const user = db.prepare('SELECT userEmail, userName FROM userInfo WHERE userEmail = ?').get(requestEmail);

        if (!user) {
            return res.status(400).json({ error: "No account found with this email." });
        }

        console.log(`User ${user.userEmail} exists! Sending password reset link...`);

        // Storing a JWT token inside the link so the system knows who the user is when they click on the link.
        const token = jwt.sign({ email: user.userEmail }, process.env.JWTSecret, { expiresIn: '1h' });

        const { data, error } = await resend.emails.send({
            from: 'Bloombox <bloombox@mathusanp.com>',
            to: user.userEmail,
            subject: 'Reset your password.',
            headers: {
                'X-Entity-Ref-ID': crypto.randomUUID()
            },
            html: `
            <h2>Hello, ${user.userName}!</h2>
            <p>We're sending you this email because you requested to reset your password. If you did not request this please ignore this email.</p>
            <a href="${url}/resetPassword?token=${token}">Reset my password.</a>`
        });

        console.log('Resend data:', data);
        console.log('Resend error:', error);

        res.status(200).json({ message: "Password reset email sent!" });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Route to reset user password
app.get('/resetPassword', (req, res) => {
    const { token } = req.query;

    try {
        jwt.verify(token, process.env.JWTSecret);
        res.redirect(`/resetPassword.html?token=${token}`);
    } catch (err) {
        res.status(400).json({ error: "Reset link is invalid or has expired." });
    }
});

// Route for when the user wants to update their password from the settings page.
app.post('/updatePassword', async (req, res) => {
    const { token, newPassword } = req.body;

    try {
        const decoded = jwt.verify(token, process.env.JWTSecret);

        const hashedPassword = await hashPassword(newPassword, saltRounds);

        db.prepare('UPDATE userInfo SET hashedPassword = ? WHERE userEmail = ?').run(hashedPassword, decoded.email);
        logAction(decoded.email, 'settings', 'manual', 'Password reset', 'Password was reset via email link');

        res.status(200).json({ message: "Password updated successfully!" });
    } catch (err) {
        res.status(400).json({ error: "Reset link is invalid or has expired." });
    }
});

// Route for when the user wants to update their nickname from the settings page.
app.post('/updateName', requireLogin, async (req, res) => {
    const { newName } = req.body;

    if (!newName) {
        return res.status(400).json({ error: "Name cannot be empty." });
    }

    if (!/^[a-zA-Z0-9_]+$/.test(newName)) {
        return res.status(400).json({ error: "Invalid username format." });
    }

    db.prepare('UPDATE userInfo SET userName = ? WHERE userEmail = ?').run(newName, req.session.user.userEmail);
    logAction(req.session.user.userEmail, 'settings', 'manual', 'Username changed', `Username updated to ${newName}`);

    req.session.user.userName = newName;

    res.status(200).json({ message: "Name updated successfully." });
});

// Returns the server's current clock so the dashboard can compute relative times against the Pi's clock instead of the browser's
app.get('/serverTime', (req, res) => {
    res.json({ now: Date.now() });
});

// Get the sensorData table
app.get('/sensorData', (req, res) => {
    try {
        const rows = db.prepare('SELECT * FROM sensorData').all();
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Systems with no real hardware - analytics returns generated values for these.
const DUMMY_SYSTEM_IDS = new Set(['2', '3']);

// Build a synthetic 24h-style series for a dummy system.
function generateDummySensorRows(type, hours, systemId) {
    const sid = parseInt(systemId);
    const points = Math.min(Math.max(hours, 1) * 2, 60); // up to 60 points
    const sysOffset = (sid - 1) * 1.5;
    const rows = [];
    const now = Date.now();
    const stepMs = (hours * 3600_000) / points;

    for (let i = points - 1; i >= 0; i--) {
        const phase = ((points - 1 - i) / points) * 2 * Math.PI;
        let value;
        switch (type) {
            case 'temperature': value = 22 + Math.sin(phase) * 4 + sysOffset;                  break;
            case 'humidity':    value = 55 + Math.cos(phase) * 15 + sysOffset * 2;             break;
            case 'light':       value = Math.max(0, Math.sin(phase - Math.PI / 2) * 80 + 40 + sysOffset * 4); break;
            default:            value = 0;
        }
        // Add a per-system wiggle so each system's curve looks distinct
        value += Math.sin(i * 0.3 + sid) * 2;

        const ts = new Date(now - i * stepMs);
        const timeStamp = ts.toISOString().slice(0, 19).replace('T', ' ');
        rows.push({
            timeStamp,
            sensorType: type,
            systemId: sid,
            sensorValue: Math.round(value * 10) / 10
        });
    }
    return rows;
}

// Sensor history for the analytics charts.
app.get('/api/sensor-data', (req, res) => {
    const { type } = req.query;
    const hours = parseInt(req.query.hours) || 24;
    const systemId = req.query.systemId;

    if (!type) return res.status(400).json({ error: 'type query param is required' });

    if (DUMMY_SYSTEM_IDS.has(systemId)) {
        return res.json({ rows: generateDummySensorRows(type, hours, systemId) });
    }

    try {
        const cutoffMs = Date.now() - hours * 3600_000;
        const cutoff = new Date(cutoffMs).toISOString().slice(0, 19).replace('T', ' ');

        let rows;
        if (systemId && systemId !== 'all') {
            rows = db.prepare(
                'SELECT timeStamp, sensorType, systemId, sensorValue FROM sensorData ' +
                'WHERE sensorType = ? AND systemId = ? AND timeStamp >= ? ORDER BY timeStamp ASC'
            ).all(type, parseInt(systemId), cutoff);
        } else {
            rows = db.prepare(
                'SELECT timeStamp, sensorType, systemId, sensorValue FROM sensorData ' +
                'WHERE sensorType = ? AND timeStamp >= ? ORDER BY timeStamp ASC'
            ).all(type, cutoff);
        }
        res.json({ rows });
    } catch (e) {
        if (/no such table/i.test(e.message)) {
            return res.status(503).json({ error: e.message });
        }
        res.status(500).json({ error: e.message });
    }
});

app.get("/analyse-plant", async (req, res) => {
    try {
        const response = await fetch("http://127.0.0.1:5000/predict");
        const data = await response.json();

        res.json({ stress: data });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error talking to pi...");
    }
});

// Route to check if a user has twofactor, mainly used for display purposes on the security page.
app.get('/twoFactorStatus', requireLogin, (req, res) => {
    const enrolled = db.prepare('SELECT userEmail FROM twoFactor WHERE userEmail = ?').get(req.session.user.userEmail);
    console.log(enrolled)
    res.status(200).json({ enrolled: enrolled ? true : false });
});

// Route to turn on two factor for a user.
app.post('/toggleTwoFactor', requireLogin, async (req, res) => {
    const enrolled = db.prepare('SELECT userEmail FROM twoFactor WHERE userEmail = ?').get(req.session.user.userEmail);

    if (enrolled) {
        db.prepare('DELETE FROM twoFactor WHERE userEmail = ?').run(req.session.user.userEmail);
        logAction(req.session.user.userEmail, 'settings', 'manual', '2FA Disabled', 'Two-factor authentication was disabled');

        await resend.emails.send({
            from: 'Bloombox <bloombox@mathusanp.com>',
            to: req.session.user.userEmail,
            subject: 'Two-Factor Authentication Disabled',
            html: `<h2>2FA Disabled</h2><p>Two-factor authentication has been disabled. If this was not you please review your settings.</p>`
        });

        return res.status(200).json({ enrolled: false });
    } else {
        db.prepare('INSERT INTO twoFactor (userEmail) VALUES (?)').run(req.session.user.userEmail);
        logAction(req.session.user.userEmail, 'settings', 'manual', '2FA Enabled', 'Two-factor authentication was enabled');

        await resend.emails.send({
            from: 'Bloombox <bloombox@mathusanp.com>',
            to: req.session.user.userEmail,
            subject: 'Two-Factor Authentication Enabled',
            html: `<h2>2FA Enabled</h2><p>Two-factor authentication has been enabled. If this was not you please review your settings.</p>`
        });

        return res.status(200).json({ enrolled: true });
    }
});

app.get('/two-factor.html', (req, res, next) => {
    if (!req.session.pendingEmail) {
        return res.redirect('/login.html');
    }
    next();
});


// Authenticating with two factor
app.post('/verifyTwoFactor', (req, res) => {
    const { code } = req.body;
    const email = req.session.pendingEmail;

    if (!email) {
        return res.status(400).json({ error: "Session expired. Please log in again." });
    }

    const twoFactor = db.prepare('SELECT * FROM twoFactor WHERE userEmail = ?').get(email);

    if (!twoFactor || twoFactor.code !== code) {
        return res.status(400).json({ error: "Incorrect code." });
    }

    if (Date.now() > twoFactor.codeExpiry) {
        return res.status(400).json({ error: "Code has expired. Please log in again." });
    }

    db.prepare('UPDATE twoFactor SET code = NULL, codeExpiry = NULL WHERE userEmail = ?').run(email);
    delete req.session.pendingEmail;

    const user = db.prepare('SELECT userName, userEmail FROM userInfo WHERE userEmail = ?').get(email);
    req.session.user = { userName: user.userName, userEmail: user.userEmail };

    logAction(email, 'settings', 'manual', 'Logged in via 2FA', 'Successful login with two-factor authentication');
    res.status(200).json({ message: "Login successful!", userName: user.userName });
});

// Resend button with rate limit
app.post('/resendTwoFactor', twoFactorLimiter, async (req, res) => {
    const email = req.session.pendingEmail;

    if (!email) {
        return res.status(400).json({ error: "Session expired, please Log in again." })
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = Date.now() + 10 * 60 * 1000;

    db.prepare('UPDATE twoFactor SET code = ?, codeExpiry = ? WHERE userEmail = ?').run(code, expiry, email)


    await resend.emails.send({
        from: 'Bloombox <bloombox@mathusanp.com>',
        to: email,
        subject: 'Your Bloombox login code',
        html: `<h2>Your login code is: <strong>${code}</strong></h2><p>This code expires in 10 minutes.</p>`
    });

    res.status(200).json({message: "Code Resent"})
})

// Option to delete account
app.delete('/deleteAccount', requireLogin, async (req, res) => {
    const email = req.session.user.userEmail;

    if (!email) {
        return res.status(400).json({error: "Sesion expired, please log in again."})
    }

    db.prepare('DELETE FROM userInfo WHERE userEmail = ?').run(email);
    db.prepare('DELETE FROM twoFactor WHERE userEmail = ?').run(email);

    await resend.emails.send({
        from: 'Bloombox <bloombox@mathusanp.com>',
        to: email,
        subject: 'Account Deletion',
        html: `<p> Sorry to see you go, your account and all related data has now been deleted.</p>`
    });

    req.session.destroy();
    res.status(200).json({message: "Account deleted"})
})

// Sending user a json of all the data we have on the associated email.
app.get('/requestData', requireLogin, requestDataLimiter, async (req, res) => {
    const email = req.session.user.userEmail

    const user = safeQuery(() => db.prepare('SELECT userName, userEmail FROM userInfo WHERE userEmail = ?').get(email), null);
    const schedules = safeQuery(() => db.prepare('SELECT * FROM waterSchedule').all(), []);
    const arduinoConfig = safeQuery(() => db.prepare('SELECT * FROM arduinoConfig').all(), []);
    const piConfig = safeQuery(() => db.prepare('SELECT * FROM piConfig').all(), []);
    let is2fa = db.prepare('SELECT userEmail FROM twoFactor WHERE userEmail = ?').get(email)

    if (is2fa) {
        is2fa = "Enrolled"
    } else {
        is2fa = "Not enrolled"
    }

    const userData = {
        account: {
            userName: user?.userName,
            userEmail: user?.userEmail,
            twoFactor: is2fa
        },
        waterSchedules: schedules,
        arduinoConfig: arduinoConfig,
        piConfig: piConfig
    }

    await resend.emails.send({
        from: 'Bloombox <bloombox@mathusanp.com>',
        to: email,
        subject: 'Your Bloombox Data',
        html: `<h2>Your Bloombox Data</h2><p>Your data export is attached as a JSON file.</p>`,
        attachments: [
            {
                filename: 'bloombox-data.json',
                content: Buffer.from(JSON.stringify(userData, null, 2)).toString('base64')
            }
        ]
    });

    logAction(email, 'settings', 'manual', 'Data requested', 'User requested a copy of their data');
    res.status(200).json({ message: "Data sent to your email." });

})

// Fetching logs from database.
app.get('/actionLogs', requireLogin, (req, res) => {
    const logs = db.prepare('SELECT cat, trig, title, detail, time FROM userLogs WHERE userEmail = ? ORDER BY time DESC').all(req.session.user.userEmail)
    res.status(200).json(logs);
});

db.exec(`
    CREATE TABLE IF NOT EXISTS twoFactor (
        userEmail TEXT PRIMARY KEY NOT NULL,
        code TEXT,
        codeExpiry INTEGER,
        FOREIGN KEY (userEmail) REFERENCES userInfo(userEmail)
    );

    CREATE TABLE IF NOT EXISTS userLogs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userEmail TEXT NOT NULL,
        cat TEXT NOT NULL,
        trig TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        time TEXT NOT NULL,
        FOREIGN KEY (userEmail) REFERENCES userInfo(userEmail)
    )
`);

