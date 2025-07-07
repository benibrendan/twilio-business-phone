require('dotenv').config();
const express = require('express');
const { twiml } = require('twilio');
const nodemailer = require('nodemailer');

// Temporary hardcoded credentials (REMOVE after testing)
// Replace with your actual values
if (!process.env.TWILIO_ACCOUNT_SID) {
  process.env.TWILIO_ACCOUNT_SID = 'YOUR_ACCOUNT_SID_HERE';
}
if (!process.env.TWILIO_AUTH_TOKEN) {
  process.env.TWILIO_AUTH_TOKEN = 'YOUR_AUTH_TOKEN_HERE';
}

// Add the phone numbers temporarily
if (!process.env.MAIN_PHONE_NUMBER) {
  process.env.MAIN_PHONE_NUMBER = '+15083942422';
}
if (!process.env.SECONDARY_PHONE_NUMBER) {
  process.env.SECONDARY_PHONE_NUMBER = '+15083943024';
}
if (!process.env.SIP_DOMAIN) {
  process.env.SIP_DOMAIN = 'allcapefence.sip.twilio.com';
}

// Set mobile phone number
if (!process.env.MOBILE_PHONE_NUMBER) {
  process.env.MOBILE_PHONE_NUMBER = '+16174139699';
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse URL-encoded bodies (Twilio sends data this way)
app.use(express.urlencoded({ extended: true }));

// Basic route to test if server is running
app.get('/', (req, res) => {
  res.send('Twilio Phone System is running! 📞');
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Main webhook endpoint for incoming calls
app.post('/webhook/voice', (req, res) => {
  console.log('Incoming call from:', req.body.From);
  console.log('To number:', req.body.To);
  console.log('Call SID:', req.body.CallSid);

  const response = new twiml.VoiceResponse();
  
  // Check if it's business hours (Monday-Friday 8am-5pm EST)
  const now = new Date();
  const est = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
  const hour = est.getHours();
  const day = est.getDay(); // 0 = Sunday, 1 = Monday, etc.
  
  const isBusinessHours = (day >= 1 && day <= 5) && (hour >= 8 && hour < 17);
  
  if (isBusinessHours) {
    // Business hours: Ring both desk phones simultaneously, then mobile, then voicemail
    response.say('Thank you for calling All Cape Fence. Please hold while we connect you.');
    
    // Dial both desk phones simultaneously
    const dial = response.dial({
      action: '/webhook/dial-status',
      method: 'POST',
      timeout: 20,
      callerId: req.body.To // Use the Twilio number as caller ID
    });
    
    // Ring both desk phones via SIP
    dial.sip('phone1@allcapefence.sip.twilio.com');
    dial.sip('phone2@allcapefence.sip.twilio.com');
    
  } else {
    // After hours: Straight to voicemail
    response.say('Thank you for calling All Cape Fence. Our office hours are Monday through Friday, 8 AM to 5 PM Eastern Time. Please leave a message after the beep.');
    
    response.record({
      action: '/webhook/recording',
      method: 'POST',
      maxLength: 120,
      finishOnKey: '#',
      recordingStatusCallback: '/webhook/recording-status'
    });
    
    response.say('We did not receive a recording. Goodbye.');
  }
  
  res.type('text/xml');
  res.send(response.toString());
});

// Handle dial status (when desk phones don't answer or are busy)
app.post('/webhook/dial-status', (req, res) => {
  console.log('Dial status:', req.body.DialCallStatus);
  console.log('Dial duration:', req.body.DialCallDuration);
  
  const response = new twiml.VoiceResponse();
  
  // If both desk phones didn't answer, try mobile phone
  if (req.body.DialCallStatus === 'no-answer' || req.body.DialCallStatus === 'busy' || req.body.DialCallStatus === 'failed') {
    
    // Try mobile phone as fallback
    response.say('Please continue to hold while we try to reach you.');
    
    const mobileDial = response.dial({
      action: '/webhook/mobile-dial-status',
      method: 'POST',
      timeout: 15,
      callerId: req.body.To
    });
    
    mobileDial.number(process.env.MOBILE_PHONE_NUMBER || '+16174139699');
    
  } else {
    // Call was answered by one of the desk phones, no further action needed
    response.hangup();
  }
  
  res.type('text/xml');
  res.send(response.toString());
});

// Handle mobile phone dial status (final fallback to voicemail)
app.post('/webhook/mobile-dial-status', (req, res) => {
  console.log('Mobile dial status:', req.body.DialCallStatus);
  console.log('Mobile dial duration:', req.body.DialCallDuration);
  
  const response = new twiml.VoiceResponse();
  
  // If mobile phone doesn't answer either, go to voicemail
  if (req.body.DialCallStatus === 'no-answer' || req.body.DialCallStatus === 'busy' || req.body.DialCallStatus === 'failed') {
    response.say('We are currently with other customers. Please leave a message after the beep.');
    
    response.record({
      action: '/webhook/recording',
      method: 'POST',
      maxLength: 120,
      finishOnKey: '#',
      recordingStatusCallback: '/webhook/recording-status'
    });
    
    response.say('We did not receive a recording. Goodbye.');
  } else {
    // Mobile phone answered
    response.hangup();
  }
  
  res.type('text/xml');
  res.send(response.toString());
});

// Handle outbound calls from desk phone
app.post('/webhook/outbound', (req, res) => {
  console.log('Outbound call from SIP phone:');
  console.log('From:', req.body.From);
  console.log('To:', req.body.To);
  console.log('Call SID:', req.body.CallSid);
  
  const response = new twiml.VoiceResponse();
  
  // Extract the destination number (remove sip: prefix if present)
  let destinationNumber = req.body.To;
  if (destinationNumber.startsWith('sip:')) {
    // Extract number from SIP URI (e.g., sip:+15551234567@... -> +15551234567)
    destinationNumber = destinationNumber.split('@')[0].replace('sip:', '');
  }
  
  // Validate the number format (should start with + for international format)
  if (!destinationNumber.startsWith('+')) {
    // If it's a 10-digit US number, add +1
    if (destinationNumber.match(/^\d{10}$/)) {
      destinationNumber = '+1' + destinationNumber;
    } else if (destinationNumber.match(/^1\d{10}$/)) {
      // If it starts with 1 and has 11 digits, add +
      destinationNumber = '+' + destinationNumber;
    } else {
      // Invalid number format
      response.say('The number you dialed is not valid. Please try again.');
      response.hangup();
      res.type('text/xml');
      res.send(response.toString());
      return;
    }
  }
  
  console.log('Formatted destination number:', destinationNumber);
  
  // Dial the destination number
  const dial = response.dial({
    callerId: process.env.MAIN_PHONE_NUMBER, // Use your main Twilio number as caller ID
    timeout: 30
  });
  dial.number(destinationNumber);
  
  res.type('text/xml');
  res.send(response.toString());
});

// Handle completed recordings
app.post('/webhook/recording', (req, res) => {
  console.log('Recording completed:');
  console.log('Recording URL:', req.body.RecordingUrl);
  console.log('Recording Duration:', req.body.RecordingDuration);
  console.log('From:', req.body.From);
  
  // Send email notification
  sendVoicemailEmail(req.body);
  
  const response = new twiml.VoiceResponse();
  response.say('Thank you for your message. We will get back to you soon. Goodbye.');
  
  res.type('text/xml');
  res.send(response.toString());
});

// Send voicemail email notification
async function sendVoicemailEmail(recordingData) {
  try {
    // Check if Gmail credentials are configured
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
      console.error('Gmail credentials not configured. Please set GMAIL_USER and GMAIL_APP_PASSWORD environment variables.');
      return;
    }
    
    if (!process.env.NOTIFICATION_EMAIL) {
      console.error('NOTIFICATION_EMAIL not configured. Please set this environment variable.');
      return;
    }
    
    // Gmail SMTP configuration
    const transporter = nodemailer.createTransporter({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER, // Your Gmail address
        pass: process.env.GMAIL_APP_PASSWORD // Gmail App Password (not regular password)
      }
    });

    const emailBody = `
New voicemail received:

From: ${recordingData.From}
To: ${recordingData.To}
Duration: ${recordingData.RecordingDuration} seconds
Date: ${new Date().toLocaleString("en-US", {timeZone: "America/New_York"})} EST

Recording URL: ${recordingData.RecordingUrl}

You can also view all voicemails at:
https://twilio-business-phone-production.up.railway.app/voicemails

-- All Cape Fence Phone System
    `;

    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: process.env.NOTIFICATION_EMAIL,
      subject: `New Voicemail from ${recordingData.From}`,
      text: emailBody
    };

    await transporter.sendMail(mailOptions);
    console.log('Voicemail email notification sent via Gmail');
  } catch (error) {
    console.error('Error sending email notification:', error);
  }
}

// Handle recording status updates
app.post('/webhook/recording-status', (req, res) => {
  console.log('Recording status update:', req.body.RecordingStatus);
  console.log('Recording SID:', req.body.RecordingSid);
  res.sendStatus(200);
});

// Test endpoint to simulate business hours
app.get('/test-hours', (req, res) => {
  const now = new Date();
  const est = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
  const hour = est.getHours();
  const day = est.getDay();
  
  const isBusinessHours = (day >= 1 && day <= 5) && (hour >= 8 && hour < 17);
  
  res.json({
    currentTime: est.toLocaleString(),
    hour: hour,
    day: day,
    dayName: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day],
    isBusinessHours: isBusinessHours,
    mobileNumber: process.env.MOBILE_PHONE_NUMBER || 'Not set'
  });
});

// Debug endpoint to check environment variables
app.get('/debug-env', (req, res) => {
  res.json({
    hasTwilioSid: !!process.env.TWILIO_ACCOUNT_SID,
    hasAuthToken: !!process.env.TWILIO_AUTH_TOKEN,
    sidPrefix: process.env.TWILIO_ACCOUNT_SID ? process.env.TWILIO_ACCOUNT_SID.substring(0, 5) + '...' : 'undefined',
    nodeEnv: process.env.NODE_ENV || 'undefined',
    mainPhone: process.env.MAIN_PHONE_NUMBER || 'undefined',
    secondaryPhone: process.env.SECONDARY_PHONE_NUMBER || 'undefined',
    sipDomain: process.env.SIP_DOMAIN || 'undefined',
    mobilePhone: process.env.MOBILE_PHONE_NUMBER || 'undefined',
    hasGmailUser: !!process.env.GMAIL_USER,
    hasGmailPassword: !!process.env.GMAIL_APP_PASSWORD,
    hasNotificationEmail: !!process.env.NOTIFICATION_EMAIL
  });
});

// Voicemail dashboard
app.get('/voicemails', async (req, res) => {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    return res.status(500).send(`Twilio credentials not configured. 
    TWILIO_ACCOUNT_SID exists: ${!!process.env.TWILIO_ACCOUNT_SID}
    TWILIO_AUTH_TOKEN exists: ${!!process.env.TWILIO_AUTH_TOKEN}
    Check /debug-env for more details.`);
  }

  try {
    const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    
    // Get recordings from the last 30 days
    const recordings = await client.recordings.list({
      limit: 50,
      dateCreatedAfter: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    });

    let html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Voicemails - Business Phone System</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 20px; }
            .voicemail { border: 1px solid #ccc; margin: 10px 0; padding: 15px; border-radius: 5px; }
            .date { color: #666; font-size: 0.9em; }
            .duration { font-weight: bold; color: #333; }
            audio { width: 100%; margin: 10px 0; }
            .no-recordings { text-align: center; color: #666; padding: 40px; }
        </style>
    </head>
    <body>
        <h1>📞 Business Voicemails</h1>
        <p>Total recordings: ${recordings.length}</p>
    `;

    if (recordings.length === 0) {
      html += '<div class="no-recordings">No voicemails found in the last 30 days.</div>';
    } else {
      recordings.forEach((recording, index) => {
        const recordingUrl = `https://api.twilio.com${recording.uri.replace('.json', '.mp3')}`;
        const authenticatedUrl = recordingUrl.replace('https://', `https://${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}@`);
        
        // Convert to EST timezone
        const estDate = new Date(recording.dateCreated).toLocaleString("en-US", {
          timeZone: "America/New_York",
          weekday: 'short',
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });
        
        html += `
          <div class="voicemail">
            <div class="date">📅 ${estDate} EST</div>
            <div class="duration">⏱️ Duration: ${recording.duration} seconds</div>
            <div>📞 Call SID: ${recording.callSid}</div>
            <audio controls>
              <source src="${authenticatedUrl}" type="audio/mpeg">
              Your browser does not support the audio element.
            </audio>
            <div><a href="${authenticatedUrl}" target="_blank">Download Recording</a></div>
          </div>
        `;
      });
    }

    html += `
        <hr>
        <p><a href="/">← Back to Home</a> | <a href="/test-hours">Test Business Hours</a></p>
    </body>
    </html>`;

    res.send(html);
  } catch (error) {
    console.error('Error fetching recordings:', error);
    res.status(500).send(`Error fetching voicemails: ${error.message}`);
  }
});

// Call analytics dashboard
app.get('/analytics', (req, res) => {
  // This will show which numbers get the most calls
  // For now, we'll parse the logs, but later we can use a database
  
  let html = `
  <!DOCTYPE html>
  <html>
  <head>
      <title>Call Analytics - All Cape Fence</title>
      <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          .metric { border: 1px solid #ccc; margin: 10px 0; padding: 15px; border-radius: 5px; }
          .number { font-weight: bold; color: #2196F3; }
          table { width: 100%; border-collapse: collapse; margin: 20px 0; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background-color: #f2f2f2; }
      </style>
  </head>
  <body>
      <h1>📊 Call Analytics - All Cape Fence</h1>
      
      <div class="metric">
          <h3>📞 Number Usage Tracking</h3>
          <p>Use this data to determine which forwarded numbers are worth keeping.</p>
          
          <table>
              <tr>
                  <th>Phone Number</th>
                  <th>Type</th>
                  <th>Calls This Week</th>
                  <th>Total Calls</th>
                  <th>Recommendation</th>
              </tr>
              <tr>
                  <td class="number">${process.env.MAIN_PHONE_NUMBER || 'Main Number'}</td>
                  <td>Primary Line</td>
                  <td>-</td>
                  <td>-</td>
                  <td>Keep (Primary)</td>
              </tr>
              <tr>
                  <td class="number">${process.env.SECONDARY_PHONE_NUMBER || 'Secondary Number'}</td>
                  <td>Secondary Line</td>
                  <td>-</td>
                  <td>-</td>
                  <td>Keep (Secondary)</td>
              </tr>
              <tr>
                  <td class="number">Forwarded Number 1</td>
                  <td>Forwarded</td>
                  <td>-</td>
                  <td>-</td>
                  <td>Monitor</td>
              </tr>
              <tr>
                  <td class="number">Forwarded Number 2</td>
                  <td>Forwarded</td>
                  <td>-</td>
                  <td>-</td>
                  <td>Monitor</td>
              </tr>
              <tr>
                  <td class="number">Forwarded Number 3</td>
                  <td>Forwarded</td>
                  <td>-</td>
                  <td>-</td>
                  <td>Monitor</td>
              </tr>
          </table>
          
          <p><strong>Note:</strong> Call tracking data will populate once the system is live. 
          Numbers with &lt;5 calls per month may be candidates for discontinuation.</p>
      </div>
      
      <hr>
      <p><a href="/">← Back to Home</a> | <a href="/voicemails">View Voicemails</a></p>
  </body>
  </html>`;

  res.send(html);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Webhook URL: https://twilio-business-phone-production.up.railway.app/webhook/voice`);
  console.log(`Mobile forwarding to: ${process.env.MOBILE_PHONE_NUMBER || 'NOT SET'}`);
});