require('dotenv').config();
const express = require('express');
const { twiml } = require('twilio');

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
      callerId: req.body.From // Use the Twilio number as caller ID
    });
    
    // Ring desk phones and office wireless via SIP
    dial.sip('sip:phone1@allcapefence.sip.twilio.com');
    dial.sip('sip:phone2@allcapefence.sip.twilio.com');
    dial.sip('sip:phone3@allcapefence.sip.twilio.com');
    
    console.log(response.toString());
    
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
    response.say('Please continue to hold while we try to a team member for you.');
    
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

// ============================================
// IMPROVED WEBHOOK ENDPOINT
// ============================================

app.post('/webhook/recording', async (req, res) => {
  console.log('🎙️  ========== RECORDING WEBHOOK TRIGGERED ==========');
  console.log('🎙️  [WEBHOOK] Timestamp:', new Date().toISOString());
  console.log('🎙️  [WEBHOOK] Request headers:', req.headers);
  
  // Log all the data Twilio sent us
  console.log('🎙️  [WEBHOOK] Request body:', JSON.stringify(req.body, null, 2));
  console.log('🎙️  [WEBHOOK] Recording URL:', req.body.RecordingUrl);
  console.log('🎙️  [WEBHOOK] Recording Duration:', req.body.RecordingDuration);
  console.log('🎙️  [WEBHOOK] From number:', req.body.From);
  console.log('🎙️  [WEBHOOK] To number:', req.body.To);
  console.log('🎙️  [WEBHOOK] Call SID:', req.body.CallSid);
  console.log('🎙️  [WEBHOOK] Recording SID:', req.body.RecordingSid);

  // Validate we have the minimum required data
  if (!req.body.RecordingUrl || !req.body.From) {
    console.error('❌ [WEBHOOK] Missing required recording data!');
    console.error('❌ [WEBHOOK] Body:', req.body);
  }

  // Send the email notification (AWAIT it so we can see the result)
  console.log('🎙️  [WEBHOOK] Calling sendVoicemailEmail...');
  const emailResult = await sendVoicemailEmail(req.body);
  
  if (emailResult.success) {
    console.log('✅ [WEBHOOK] Email notification sent successfully!');
    console.log('✅ [WEBHOOK] Message ID:', emailResult.messageId);
  } else {
    console.error('❌ [WEBHOOK] Email notification failed!');
    console.error('❌ [WEBHOOK] Error:', emailResult.error);
    console.error('❌ [WEBHOOK] Error code:', emailResult.code);
  }

  // Respond to Twilio with TwiML
  const response = new twiml.VoiceResponse();
  response.say('Thank you for your message. We will get back to you soon. Goodbye.');

  console.log('🎙️  [WEBHOOK] Sending TwiML response back to Twilio');
  res.type('text/xml');
  res.send(response.toString());
  console.log('🎙️  ========== WEBHOOK PROCESSING COMPLETE ==========\n');
});

// ============================================
// IMPROVED EMAIL FUNCTION WITH FULL DEBUGGING
// ============================================

async function sendVoicemailEmail(recordingData) {
  console.log('📧 ========== EMAIL FUNCTION STARTED ==========');
  console.log('📧 [EMAIL] Timestamp:', new Date().toISOString());
  
  // Log what data we received
  console.log('📧 [EMAIL] Recording data received:', {
    from: recordingData.From,
    duration: recordingData.RecordingDuration,
    url: recordingData.RecordingUrl,
    sid: recordingData.RecordingSid,
    hasAllData: !!(recordingData.From && recordingData.RecordingDuration && recordingData.RecordingUrl)
  });

  // Check environment variables
  console.log('📧 [EMAIL] Environment variables check:', {
    hasBrevoApiKey: !!process.env.BREVO_API_KEY,
    hasBrevoSender: !!process.env.BREVO_SENDER_EMAIL,
    hasTwilioSid: !!process.env.TWILIO_ACCOUNT_SID,
    hasTwilioToken: !!process.env.TWILIO_AUTH_TOKEN,
    brevoKeyLength: process.env.BREVO_API_KEY?.length,
    brevoSender: process.env.BREVO_SENDER_EMAIL
  });

  try {
    // Validate environment variables
    if (!process.env.BREVO_API_KEY) {
      throw new Error('BREVO_API_KEY environment variable is not set');
    }
    if (!process.env.BREVO_SENDER_EMAIL) {
      throw new Error('BREVO_SENDER_EMAIL environment variable is not set');
    }
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      throw new Error('Twilio credentials not set');
    }

    console.log('📧 [EMAIL] Preparing to download recording from Twilio...');
    
    // Get the recording SID from the data
    const recordingSid = recordingData.RecordingSid;
    console.log('📧 [EMAIL] Recording SID:', recordingSid);

    // Build the MP3 URL
    const recordingMp3Url = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/${recordingSid}.mp3`;
    console.log('📧 [EMAIL] MP3 URL:', recordingMp3Url);

    // Create Basic Auth header
    const authHeader = 'Basic ' + Buffer.from(
      `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
    ).toString('base64');

    // Wait for recording to be ready, with retries
    let audioBuffer = null;
    let attempts = 0;
    const maxAttempts = 5;
    const delayMs = 2000; // 2 seconds between attempts

    console.log('📧 [EMAIL] Waiting for recording to be ready (this may take a few seconds)...');
    
    while (attempts < maxAttempts && !audioBuffer) {
      attempts++;
      console.log(`📧 [EMAIL] Download attempt ${attempts}/${maxAttempts}...`);
      
      // Wait before attempting (except first attempt)
      if (attempts > 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }

      const audioResponse = await fetch(recordingMp3Url, {
        method: 'GET',
        headers: {
          'Authorization': authHeader
        }
      });

      console.log(`📧 [EMAIL] Attempt ${attempts} - Status:`, audioResponse.status);
      console.log(`📧 [EMAIL] Attempt ${attempts} - Content-Type:`, audioResponse.headers.get('content-type'));

      // Check if we got audio (not XML error)
      const contentType = audioResponse.headers.get('content-type');
      
      if (audioResponse.ok && contentType && contentType.includes('audio')) {
        // Success! We got the audio file
        audioBuffer = await audioResponse.arrayBuffer();
        console.log('✅ [EMAIL] Recording downloaded successfully!');
        break;
      } else if (audioResponse.ok && contentType && contentType.includes('xml')) {
        // Got XML response - recording not ready yet
        console.log(`⏳ [EMAIL] Attempt ${attempts} - Recording not ready yet (got XML response)`);
        if (attempts < maxAttempts) {
          console.log(`⏳ [EMAIL] Waiting ${delayMs/1000} seconds before retry...`);
        }
      } else {
        // Other error
        console.warn(`⚠️ [EMAIL] Attempt ${attempts} - Status ${audioResponse.status}`);
        if (attempts < maxAttempts) {
          console.log(`⏳ [EMAIL] Waiting ${delayMs/1000} seconds before retry...`);
        }
      }
    }

    if (!audioBuffer) {
      throw new Error(`Failed to download recording after ${maxAttempts} attempts. Recording may not be ready yet.`);
    }

    const audioBase64 = Buffer.from(audioBuffer).toString('base64');
    
    console.log('📧 [EMAIL] Audio file processed:', {
      size: audioBuffer.byteLength,
      sizeKB: (audioBuffer.byteLength / 1024).toFixed(2) + ' KB',
      attempts: attempts
    });

    console.log('📧 [EMAIL] Creating Brevo email message with attachment...');
    
    // Format phone number for filename
    const phoneNumber = recordingData.From.replace(/[^0-9]/g, '');
    
    // Get current time in EST - FIXED VERSION
    const now = new Date();
    
    // Log for debugging
    console.log('📧 [EMAIL] Current UTC time:', now.toISOString());
    
    // Format in EST timezone - this is the correct way
    const estTimeFormatted = now.toLocaleString("en-US", {
      timeZone: "America/New_York",
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    }) + ' EST';
    
    console.log('📧 [EMAIL] Formatted EST time:', estTimeFormatted);
    
    // Timestamp for filename (use UTC ISO format then convert)
    const timestamp = now.toISOString().replace(/[:.]/g, '-').split('.')[0].replace('T', '-');
    const filename = `voicemail-${phoneNumber}-${timestamp}.mp3`;

    const emailData = {
      sender: {
        name: "All Cape Fence Voicemail",
        email: process.env.BREVO_SENDER_EMAIL
      },
      to: [
        {
          email: "bdowdall@allcapefence.com",
          name: "Brendan Dowdall"
        },
        {
          email: "rmastrianna@allcapefence.com",
          name: "Robert Mastrianna"
        }
      ],
      subject: `📞 New Voicemail from ${recordingData.From}`,
      textContent: `
New voicemail received!

From: ${recordingData.From}
Duration: ${recordingData.RecordingDuration} seconds
Received: ${estTimeFormatted}

The voicemail audio file is attached to this email.

---
This is an automated notification from your Twilio voicemail system.
      `,
      htmlContent: `
        <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #f5f5f5;">
          <div style="background-color: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
            <h2 style="color: #2563eb; margin-top: 0;">📞 New Voicemail Received</h2>
            <p><strong>From:</strong> ${recordingData.From}</p>
            <p><strong>Duration:</strong> ${recordingData.RecordingDuration} seconds</p>
            <p><strong>Received:</strong> ${estTimeFormatted}</p>
            <div style="background: #f0f9ff; padding: 15px; border-radius: 6px; margin: 20px 0; border-left: 4px solid #2563eb;">
              <p style="margin: 0; color: #1e40af;">
                🎧 <strong>The voicemail audio file is attached to this email.</strong>
              </p>
              <p style="margin: 5px 0 0 0; font-size: 12px; color: #64748b;">
                Filename: ${filename}
              </p>
            </div>
            <p style="color: #666; font-size: 12px; margin-top: 30px; border-top: 1px solid #ddd; padding-top: 10px;">
              This is an automated notification from your Twilio voicemail system.
            </p>
          </div>
        </div>
      `,
      attachment: [
        {
          content: audioBase64,
          name: filename
        }
      ]
    };

    console.log('📧 [EMAIL] Prepared email:', {
      from: emailData.sender.email,
      to: emailData.to.map(t => t.email),
      subject: emailData.subject,
      attachmentName: filename,
      attachmentSizeKB: (audioBuffer.byteLength / 1024).toFixed(2) + ' KB',
      receivedTime: estTimeFormatted
    });

    // Send the email via Brevo API
    console.log('📧 [EMAIL] Sending email with attachment via Brevo...');
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': process.env.BREVO_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify(emailData)
    });

    const responseData = await response.json();
    
    if (response.ok) {
      console.log('✅ ========== EMAIL SENT SUCCESSFULLY ==========');
      console.log('✅ [EMAIL] Brevo response status:', response.status);
      console.log('✅ [EMAIL] Brevo message ID:', responseData.messageId);
      console.log('✅ [EMAIL] Sent to:', emailData.to.map(t => t.email).join(', '));
      console.log('✅ [EMAIL] Attachment included:', filename);
      console.log('✅ [EMAIL] Total attempts needed:', attempts);
      
      return { 
        success: true, 
        statusCode: response.status,
        messageId: responseData.messageId,
        attachmentSize: audioBuffer.byteLength,
        attempts: attempts
      };
    } else {
      throw new Error(`Brevo API error: ${responseData.message || 'Unknown error'}`);
    }

  } catch (error) {
    console.error('❌ ========== EMAIL FAILED ==========');
    console.error('❌ [EMAIL] Error type:', error.constructor.name);
    console.error('❌ [EMAIL] Error message:', error.message);
    console.error('❌ [EMAIL] Error code:', error.code);
    
    // Log the full error object
    console.error('❌ [EMAIL] Full error object:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
    
    return { 
      success: false, 
      error: error.message,
      code: error.code
    };
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

// ============================================
// DIAGNOSTIC ENDPOINTS (For troubleshooting)
// ============================================

// Test email functionality without making a phone call
// Updated diagnostic endpoints for Brevo
// Replace your existing /test-email and /diagnose endpoints with these

// Test email functionality without making a phone call
app.get('/test-email', async (req, res) => {
  console.log('🧪 [TEST] Test email endpoint called');
  
  try {
    const testData = {
      From: '+15555551234',
      RecordingDuration: '42',
      RecordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/ACXXXXXXXX/Recordings/REXXXXXXXX'
    };
    
    console.log('🧪 [TEST] Sending test email with fake data...');
    const result = await sendVoicemailEmail(testData);
    
    if (result.success) {
      res.send(`
        <html>
          <head><title>Email Test Result</title></head>
          <body style="font-family: Arial, sans-serif; padding: 40px;">
            <h1 style="color: green;">✅ Test Email Sent Successfully via Brevo!</h1>
            <p><strong>Status Code:</strong> ${result.statusCode}</p>
            <p><strong>Message ID:</strong> ${result.messageId}</p>
            <p>Check your inbox at: <strong>${process.env.NOTIFICATION_EMAIL || process.env.BREVO_SENDER_EMAIL}</strong></p>
            <p style="margin-top: 30px; color: #666;">
              If you don't see the email within 2 minutes:
              <ul>
                <li>Check your spam folder</li>
                <li>Verify the email address in your Railway environment variables</li>
                <li>Check Railway logs for more details</li>
                <li>Verify your Brevo API key is active</li>
              </ul>
            </p>
            <p><a href="/diagnose">Run Full Diagnostics</a></p>
          </body>
        </html>
      `);
    } else {
      res.status(500).send(`
        <html>
          <head><title>Email Test Failed</title></head>
          <body style="font-family: Arial, sans-serif; padding: 40px;">
            <h1 style="color: red;">❌ Test Email Failed</h1>
            <p><strong>Error:</strong> ${result.error}</p>
            <p><strong>Error Code:</strong> ${result.code || 'N/A'}</p>
            <p style="margin-top: 30px;">
              <strong>Check Railway logs for detailed error information.</strong>
            </p>
            <p><a href="/diagnose">Run Full Diagnostics</a></p>
          </body>
        </html>
      `);
    }
  } catch (error) {
    console.error('🧪 [TEST] Test endpoint error:', error);
    res.status(500).send(`
      <html>
        <head><title>Email Test Error</title></head>
        <body style="font-family: Arial, sans-serif; padding: 40px;">
          <h1 style="color: red;">❌ Test Failed with Exception</h1>
          <p><strong>Error:</strong> ${error.message}</p>
          <pre style="background: #f5f5f5; padding: 15px; border-radius: 4px;">${error.stack}</pre>
          <p><a href="/diagnose">Run Full Diagnostics</a></p>
        </body>
      </html>
    `);
  }
});

// Comprehensive diagnostic endpoint for Brevo
app.get('/diagnose', async (req, res) => {
  console.log('🔍 [DIAGNOSE] Running comprehensive diagnostics...');
  
  const diagnosis = {
    timestamp: new Date().toISOString(),
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      hasBrevoApiKey: !!process.env.BREVO_API_KEY,
      hasBrevoSender: !!process.env.BREVO_SENDER_EMAIL,
      hasNotificationEmail: !!process.env.NOTIFICATION_EMAIL,
      brevoKeyLength: process.env.BREVO_API_KEY?.length || 0,
      brevoKeyPrefix: process.env.BREVO_API_KEY?.substring(0, 15) || 'NOT SET',
      brevoSender: process.env.BREVO_SENDER_EMAIL || 'NOT SET',
      notificationEmail: process.env.NOTIFICATION_EMAIL || 'NOT SET (will use BREVO_SENDER_EMAIL)'
    },
    tests: {}
  };

  // Test 1: Environment variables
  diagnosis.tests.environmentVariables = {
    status: (process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL) ? 'PASS' : 'FAIL',
    details: !process.env.BREVO_API_KEY ? 'BREVO_API_KEY is missing' : 
             !process.env.BREVO_SENDER_EMAIL ? 'BREVO_SENDER_EMAIL is missing' : 
             'All required variables present'
  };

  // Test 2: Brevo API key format
  if (process.env.BREVO_API_KEY) {
    const isValidFormat = process.env.BREVO_API_KEY.startsWith('xkeysib-');
    diagnosis.tests.apiKeyFormat = {
      status: isValidFormat ? 'PASS' : 'FAIL',
      details: isValidFormat ? 'API key has correct xkeysib- prefix' : 'API key should start with "xkeysib-"'
    };
  } else {
    diagnosis.tests.apiKeyFormat = {
      status: 'SKIPPED',
      details: 'No API key to validate'
    };
  }

  // Test 3: Test Brevo API connection
  if (process.env.BREVO_API_KEY) {
    try {
      const response = await fetch('https://api.brevo.com/v3/account', {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'api-key': process.env.BREVO_API_KEY
        }
      });
      
      if (response.ok) {
        const accountData = await response.json();
        diagnosis.tests.brevoConnection = {
          status: 'PASS',
          details: `Connected to Brevo account: ${accountData.email || 'Unknown'}`,
          accountInfo: accountData.email
        };
      } else {
        diagnosis.tests.brevoConnection = {
          status: 'FAIL',
          details: `API returned status ${response.status}`,
          hint: response.status === 401 ? 'Invalid API key' : 'API connection failed'
        };
      }
    } catch (error) {
      diagnosis.tests.brevoConnection = {
        status: 'FAIL',
        details: error.message
      };
    }
  } else {
    diagnosis.tests.brevoConnection = {
      status: 'SKIPPED',
      details: 'No API key configured'
    };
  }

  // Test 4: Attempt to send test email
  try {
    const testData = {
      From: '+15555559999',
      RecordingDuration: '15',
      RecordingUrl: 'https://api.twilio.com/test-recording-url'
    };
    const emailResult = await sendVoicemailEmail(testData);
    diagnosis.tests.sendTestEmail = {
      status: emailResult.success ? 'PASS' : 'FAIL',
      details: emailResult.success ? 
        `Email sent! Status code: ${emailResult.statusCode}, Message ID: ${emailResult.messageId}` : 
        emailResult.error,
      messageId: emailResult.messageId
    };
  } catch (error) {
    diagnosis.tests.sendTestEmail = {
      status: 'FAIL',
      details: error.message
    };
  }

  // Generate HTML response
  const passCount = Object.values(diagnosis.tests).filter(t => t.status === 'PASS').length;
  const failCount = Object.values(diagnosis.tests).filter(t => t.status === 'FAIL').length;
  
  const htmlResponse = `
    <html>
      <head>
        <title>Twilio Email Diagnostics (Brevo)</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 40px; background: #f5f5f5; }
          .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
          h1 { color: #333; border-bottom: 3px solid #2563eb; padding-bottom: 10px; }
          .summary { display: flex; gap: 20px; margin: 20px 0; }
          .summary-card { flex: 1; padding: 15px; border-radius: 6px; text-align: center; }
          .summary-card.pass { background: #dcfce7; border: 2px solid #16a34a; }
          .summary-card.fail { background: #fee2e2; border: 2px solid #dc2626; }
          .test-result { margin: 15px 0; padding: 15px; border-radius: 6px; border-left: 4px solid #ddd; }
          .test-result.pass { background: #f0fdf4; border-left-color: #16a34a; }
          .test-result.fail { background: #fef2f2; border-left-color: #dc2626; }
          .test-result.skipped { background: #fef9e5; border-left-color: #f59e0b; }
          .status { font-weight: bold; font-size: 18px; }
          .status.pass { color: #16a34a; }
          .status.fail { color: #dc2626; }
          .status.skipped { color: #f59e0b; }
          pre { background: #f5f5f5; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 12px; }
          .hint { background: #fff4d5; padding: 10px; border-radius: 4px; margin-top: 10px; border-left: 4px solid #f59e0b; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🔍 Twilio Voicemail Email Diagnostics (Brevo)</h1>
          <p><strong>Timestamp:</strong> ${diagnosis.timestamp}</p>
          
          <div class="summary">
            <div class="summary-card pass">
              <h2>${passCount}</h2>
              <p>Tests Passed</p>
            </div>
            <div class="summary-card fail">
              <h2>${failCount}</h2>
              <p>Tests Failed</p>
            </div>
          </div>

          <h2>Environment Variables</h2>
          <pre>${JSON.stringify(diagnosis.environment, null, 2)}</pre>

          <h2>Test Results</h2>
          ${Object.entries(diagnosis.tests).map(([testName, result]) => `
            <div class="test-result ${result.status.toLowerCase()}">
              <div class="status ${result.status.toLowerCase()}">
                ${result.status === 'PASS' ? '✅' : result.status === 'FAIL' ? '❌' : '⚠️'} 
                ${testName.replace(/([A-Z])/g, ' $1').trim()}
              </div>
              <p><strong>Details:</strong> ${result.details}</p>
              ${result.accountInfo ? `<p><strong>Account:</strong> ${result.accountInfo}</p>` : ''}
              ${result.messageId ? `<p><strong>Message ID:</strong> ${result.messageId}</p>` : ''}
              ${result.hint ? `<div class="hint">💡 <strong>Hint:</strong> ${result.hint}</div>` : ''}
            </div>
          `).join('')}

          <h2>Next Steps</h2>
          ${failCount > 0 ? `
            <div style="background: #fef2f2; padding: 15px; border-radius: 6px; border-left: 4px solid #dc2626;">
              <p><strong>Issues detected!</strong> Follow these steps:</p>
              <ol>
                ${!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL ? 
                  '<li>Set missing environment variables in Railway</li>' : ''}
                ${diagnosis.tests.apiKeyFormat?.status === 'FAIL' ? 
                  '<li>Your API key doesn\'t start with "xkeysib-" - check your Brevo dashboard for the correct key</li>' : ''}
                ${diagnosis.tests.brevoConnection?.status === 'FAIL' ? 
                  '<li>Verify your API key at: <a href="https://app.brevo.com/settings/keys/api" target="_blank">Brevo API Keys</a></li>' : ''}
              </ol>
            </div>
          ` : `
            <div style="background: #f0fdf4; padding: 15px; border-radius: 6px; border-left: 4px solid #16a34a;">
              <p><strong>✅ All tests passed!</strong> Your email system should be working.</p>
              <p>If you're still not receiving emails:</p>
              <ul>
                <li>Check your spam folder</li>
                <li>Verify Twilio webhook is configured correctly</li>
                <li>Leave a test voicemail and check Railway logs</li>
              </ul>
            </div>
          `}

          <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd;">
            <p>
              <a href="/test-email" style="background: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; margin-right: 10px;">
                Send Test Email
              </a>
              <a href="/diagnose" style="background: #6b7280; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">
                Run Diagnostics Again
              </a>
            </p>
          </div>
        </div>
      </body>
    </html>
  `;

  console.log('🔍 [DIAGNOSE] Diagnostics complete');
  console.log('🔍 [DIAGNOSE] Results:', JSON.stringify(diagnosis, null, 2));
  
  res.send(htmlResponse);
});