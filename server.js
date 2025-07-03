// SIMPLE TEST VERSION - Replace your current webhook temporarily

app.post('/webhook/voice', (req, res) => {
  console.log('=== SIMPLE TEST VERSION ===');
  console.log('Incoming call from:', req.body.From);
  console.log('To number:', req.body.To);
  
  const response = new twiml.VoiceResponse();
  
  // Simple business hours check
  const now = new Date();
  const est = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
  const hour = est.getHours();
  const day = est.getDay();
  const isBusinessHours = (day >= 1 && day <= 5) && (hour >= 8 && hour < 17);
  
  console.log('Business Hours:', isBusinessHours, 'Hour:', hour, 'Day:', day);
  
  if (isBusinessHours) {
    console.log('BUSINESS HOURS - SHOULD RING MOBILE');
    
    // Business hours - ring mobile
    response.say('Thank you for calling All Cape Fence. Connecting you now.');
    
    // This should ring your mobile
    response.dial('+16174139699');
    
    // If no answer
    response.say('Please leave a message after the beep.');
    response.record({
      action: '/webhook/recording',
      method: 'POST',
      maxLength: 120
    });
    
  } else {
    console.log('AFTER HOURS - STRAIGHT TO VOICEMAIL');
    
    // After hours - straight to voicemail
    response.say('Thank you for calling All Cape Fence. Our office hours are Monday through Friday, 8 AM to 5 PM Eastern Time. Please leave a message after the beep.');
    response.record({
      action: '/webhook/recording',
      method: 'POST',
      maxLength: 120
    });
  }
  
  res.type('text/xml');
  res.send(response.toString());
});