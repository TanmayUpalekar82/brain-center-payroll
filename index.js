const { MongoClient, ObjectId } = require('mongodb');

const MONGO_URI = process.env.MONGODB_URI;
const DB_NAME   = 'clinic_payroll';

let client;
async function getDB() {
  if (!client) {
    client = new MongoClient(MONGO_URI);
    await client.connect();
  }
  return client.db(DB_NAME);
}

function now() {
  return new Date().toLocaleString('en-IN', { hour12: false });
}

function json(res, data, status = 200) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(status).json(data);
}

// Match a route regardless of /api prefix
function match(url, pattern) {
  const clean = url.replace(/^\/api/, '').replace(/^\//, '');
  const pat   = pattern.replace(/^\//, '');
  return clean === pat;
}

function matchRegex(url, regex) {
  const clean = url.replace(/^\/api/, '');
  return clean.match(regex);
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  const url    = req.url.replace(/\?.*$/, '');
  const method = req.method;

  // DEBUG — always works regardless of prefix
  if (url.includes('debug')) {
    return json(res, { url, method, nodejs: process.version });
  }

  try {
    const db            = await getDB();
    const employees     = db.collection('employees');
    const salaryRecords = db.collection('salary_records');

    // ── AUTH ──────────────────────────────────────────────
    if (match(url, 'login') && method === 'POST') {
      const { username, password } = req.body;
      if (username === 'admin' && password === 'bc@123') {
        return json(res, { success: true, name: 'Dr. Pawan Ojha' });
      }
      return json(res, { success: false, message: 'Invalid credentials' }, 401);
    }

    // ── GET ALL EMPLOYEES ──────────────────────────────────
    if (match(url, 'employees') && method === 'GET') {
      const rows = await employees.find({ active: 1 }).sort({ name: 1 }).toArray();
      return json(res, { success: true, employees: rows.map(e => ({ ...e, id: e._id.toString() })) });
    }

    // ── ADD EMPLOYEE ───────────────────────────────────────
    if (match(url, 'employees') && method === 'POST') {
      const d = req.body;
      const doc = {
        name:           d.name,
        doj:            d.doj            || '',
        designation:    d.designation    || '',
        salary_per_day: parseFloat(d.salary_per_day) || 0,
        extra_day_rate: parseFloat(d.extra_day_rate) || 0,
        tds_percent:    parseFloat(d.tds_percent)    || 0,
        prof_tax:       parseFloat(d.prof_tax)       || 0,
        active:         1,
        created_at:     now(),
      };
      const result = await employees.insertOne(doc);
      return json(res, { success: true, id: result.insertedId.toString() });
    }

    // ── SINGLE EMPLOYEE ────────────────────────────────────
    const empMatch = matchRegex(url, /^\/employees\/([a-f0-9]{24})$/i);
    if (empMatch) {
      const id = empMatch[1];

      if (method === 'GET') {
        const emp     = await employees.findOne({ _id: new ObjectId(id) });
        const records = await salaryRecords.find({ employee_id: id }).sort({ month: -1 }).toArray();
        return json(res, {
          success:  true,
          employee: emp ? { ...emp, id: emp._id.toString() } : null,
          records:  records.map(r => ({ ...r, id: r._id.toString() }))
        });
      }

      if (method === 'PUT') {
        const d = req.body;
        await employees.updateOne({ _id: new ObjectId(id) }, { $set: {
          name:           d.name,
          doj:            d.doj            || '',
          designation:    d.designation    || '',
          salary_per_day: parseFloat(d.salary_per_day) || 0,
          extra_day_rate: parseFloat(d.extra_day_rate) || 0,
          tds_percent:    parseFloat(d.tds_percent)    || 0,
          prof_tax:       parseFloat(d.prof_tax)       || 0,
        }});
        return json(res, { success: true });
      }

      if (method === 'DELETE') {
        await employees.updateOne({ _id: new ObjectId(id) }, { $set: { active: 0 } });
        return json(res, { success: true });
      }
    }

    // ── EXPORT MONTHS ──────────────────────────────────────
    if (match(url, 'export/months') && method === 'GET') {
      const rows   = await salaryRecords.find({}, { projection: { month: 1 } }).toArray();
      const months = [...new Set(rows.map(r => r.month))].filter(Boolean);
      months.sort((a, b) => b.localeCompare(a));
      return json(res, { success: true, months });
    }

    // ── GET SALARY BY MONTH ────────────────────────────────
    const salMonthMatch = matchRegex(url, /^\/salary\/(.+)$/);
    if (salMonthMatch && method === 'GET') {
      const month = salMonthMatch[1];
      const rows  = await salaryRecords.find({ month }).toArray();
      const enriched = await Promise.all(rows.map(async r => {
        const emp = await employees.findOne({ _id: new ObjectId(r.employee_id) });
        return {
          ...r,
          id:             r._id.toString(),
          name:           emp?.name           || '',
          designation:    emp?.designation    || '',
          doj:            emp?.doj            || '',
          salary_per_day: emp?.salary_per_day || 0,
          tds_percent:    emp?.tds_percent    || 0,
          prof_tax:       emp?.prof_tax       || 0,
          extra_day_rate: emp?.extra_day_rate || 0,
        };
      }));
      enriched.sort((a, b) => a.name.localeCompare(b.name));
      return json(res, { success: true, records: enriched });
    }

    // ── SAVE SALARY ────────────────────────────────────────
    if (match(url, 'salary') && method === 'POST') {
      const d        = req.body;
      const existing = await salaryRecords.findOne({ employee_id: d.employee_id, month: d.month });
      const salDoc   = {
        employee_id:      d.employee_id,
        month:            d.month,
        days_present:     d.days_present,
        days_absent:      d.days_absent,
        extra_days:       d.extra_days,
        incentive:        d.incentive,
        other_dues:       d.other_dues,
        advance:          d.advance,
        other_deductions: d.other_deductions,
        gross:            d.gross,
        tds_amount:       d.tds_amount,
        nett:             d.nett,
        comment:          d.comment || '',
        processed_at:     now(),
      };
      if (existing) {
        await salaryRecords.updateOne({ _id: existing._id }, { $set: salDoc });
      } else {
        await salaryRecords.insertOne(salDoc);
      }
      return json(res, { success: true });
    }

    // 404 with debug info
    return json(res, { success: false, error: 'Route not found', url }, 404);

  } catch (err) {
    console.error(err);
    return json(res, { success: false, error: err.message }, 500);
  }
};
