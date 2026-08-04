import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(__dirname));

// Supabase server client
const SUPABASE_URL = process.env.SUPABASE_URL || "https://iloorpteokebshvjowwe.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

let supabase = null;
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log('Server Supabase client initialized for:', SUPABASE_URL);
  } catch (err) {
    console.error('Server Supabase init failed:', err);
  }
}

// Data persistence setup
const DATA_DIR = path.join(__dirname, 'data');
const APPOINTMENTS_FILE = path.join(DATA_DIR, 'appointments.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Helper to read appointments
function getAppointments() {
  try {
    if (fs.existsSync(APPOINTMENTS_FILE)) {
      const data = fs.readFileSync(APPOINTMENTS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error reading appointments file:', err);
  }
  return [];
}

// Helper to save appointments
function saveAppointments(appointments) {
  try {
    fs.writeFileSync(APPOINTMENTS_FILE, JSON.stringify(appointments, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing appointments file:', err);
  }
}

// In-memory active admin tokens
const activeAdminTokens = new Set();

const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'clinic123';

// Auth middleware
function requireAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Unauthorized access. Please login as admin.' });
  }
  const token = authHeader.split(' ')[1];
  if (!activeAdminTokens.has(token)) {
    return res.status(401).json({ success: false, message: 'Invalid or expired session token.' });
  }
  next();
}

// Public API: Book an appointment
app.post('/api/appointments', async (req, res) => {
  const { patientName, phone, email, age, gender, service, preferredDate, preferredTimeSlot, notes } = req.body;

  if (!patientName || !phone || !service || !preferredDate) {
    return res.status(400).json({ 
      success: false, 
      message: 'Please provide patient name, phone number, service requested, and preferred date.' 
    });
  }

  const appointments = getAppointments();
  
  // Generate Reference Number NSH-YYYYMMDD-XXXX
  const dateStr = new Date().toISOString().slice(0,10).replace(/-/g, '');
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  const refNumber = `NSH-${dateStr}-${randomSuffix}`;

  const newAppointment = {
    id: crypto.randomUUID(),
    refNumber,
    patientName: patientName.trim(),
    phone: phone.trim(),
    email: email ? email.trim() : '',
    age: age ? age.toString().trim() : '',
    gender: gender || 'Not Specified',
    service,
    preferredDate,
    preferredTimeSlot: preferredTimeSlot || 'Morning (9:00 AM - 12:00 PM)',
    notes: notes ? notes.trim() : '',
    status: 'Pending', // Pending, Confirmed, Completed, Cancelled
    adminNotes: '',
    createdAt: new Date().toISOString()
  };

  appointments.unshift(newAppointment);
  saveAppointments(appointments);

  if (supabase) {
    try {
      await supabase.from('appointments').upsert([newAppointment]);
    } catch (err) {
      console.error('Supabase server insert error:', err);
    }
  }

  res.status(201).json({
    success: true,
    message: 'Appointment request submitted successfully!',
    appointment: newAppointment
  });
});

// Admin API: Login
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = crypto.randomBytes(32).toString('hex');
    activeAdminTokens.add(token);
    return res.json({
      success: true,
      message: 'Admin login successful',
      token,
      username: ADMIN_USER
    });
  }

  return res.status(401).json({
    success: false,
    message: 'Invalid username or password.'
  });
});

// Admin API: Check Auth session
app.get('/api/admin/verify', requireAdminAuth, (req, res) => {
  res.json({ success: true, username: ADMIN_USER });
});

// Admin API: Get all appointments
app.get('/api/appointments', requireAdminAuth, async (req, res) => {
  if (supabase) {
    try {
      const { data, error } = await supabase.from('appointments').select('*').order('createdAt', { ascending: false });
      if (!error && Array.isArray(data)) {
        return res.json({ success: true, appointments: data });
      }
    } catch (err) {
      console.error('Supabase fetch error:', err);
    }
  }

  const appointments = getAppointments();
  res.json({
    success: true,
    appointments
  });
});

// Admin API: Update appointment status/notes
app.patch('/api/appointments/:id', requireAdminAuth, async (req, res) => {
  const { id } = req.params;
  const { status, adminNotes, preferredTimeSlot } = req.body;

  if (supabase) {
    try {
      const updates = {};
      if (status) updates.status = status;
      if (adminNotes !== undefined) updates.adminNotes = adminNotes;
      if (preferredTimeSlot !== undefined) updates.preferredTimeSlot = preferredTimeSlot;
      await supabase.from('appointments').update(updates).eq('id', id);
    } catch (err) {
      console.error('Supabase update error:', err);
    }
  }

  const appointments = getAppointments();
  const index = appointments.findIndex(a => a.id === id);

  if (index === -1) {
    return res.status(404).json({ success: false, message: 'Appointment not found.' });
  }

  if (status && ['Pending', 'Confirmed', 'Completed', 'Cancelled'].includes(status)) {
    appointments[index].status = status;
  }
  if (adminNotes !== undefined) {
    appointments[index].adminNotes = adminNotes;
  }
  if (preferredTimeSlot !== undefined) {
    appointments[index].preferredTimeSlot = preferredTimeSlot;
  }

  appointments[index].updatedAt = new Date().toISOString();

  saveAppointments(appointments);

  res.json({
    success: true,
    message: 'Appointment updated successfully',
    appointment: appointments[index]
  });
});

// Admin API: Delete appointment
app.delete('/api/appointments/:id', requireAdminAuth, async (req, res) => {
  const { id } = req.params;

  if (supabase) {
    try {
      await supabase.from('appointments').delete().eq('id', id);
    } catch (err) {
      console.error('Supabase delete error:', err);
    }
  }

  let appointments = getAppointments();
  const initialLength = appointments.length;

  appointments = appointments.filter(a => a.id !== id);

  if (appointments.length === initialLength) {
    return res.status(404).json({ success: false, message: 'Appointment not found.' });
  }

  saveAppointments(appointments);

  res.json({
    success: true,
    message: 'Appointment deleted successfully'
  });
});

// Serve index.html for SPA routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});


