/** @jsxImportSource react */
import React, { useState, useEffect, useRef } from 'react';

// ── SessionStorage helpers ────────────────────────────────────────────────────
const getTokens = () => {
  try { return JSON.parse(sessionStorage.getItem('userTokens') || '{}'); }
  catch { return {}; }
};

const getSavedUserData = () => {
  try { return JSON.parse(sessionStorage.getItem('userData') || '{}'); }
  catch { return {}; }
};

const getStoredUtms = () => {
  const result = {};
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(k => {
    const v = sessionStorage.getItem(k); if (v) result[k] = v;
  });
  return result;
};

const createToken = (name) => {
  const value = Math.random().toString(36).substring(2) + Date.now().toString(36);
  const tokens = getTokens();
  tokens[name] = value;
  sessionStorage.setItem('userTokens', JSON.stringify(tokens));
  return value;
};

// ── Questions ─────────────────────────────────────────────────────────────────
const questions = [
  {
    field: 'experience',
    title: 'Have attempted any kind of online selling before? (Ecommerce, Dropshipping, etc...)',
    options: [
      { value: 'no',          label: "No, I'm Completely New" },
      { value: 'ecommerce',   label: 'I Tried Ecommerce Before' },
      { value: 'dropship',    label: 'I Tried Dropshipping Before' },
      { value: 'both',        label: 'I Tried Both' },
    ]
  },
  {
    field: 'budget',
    title: 'We Recommend that you have a sufficient capital in order to start your online store (products costs, ads...). Do you have access to at least a budget of $700?',
    options: [
      { value: 'yes',     label: 'Yes, I have the capital' },
      { value: 'partial', label: 'I have at least $700' },
      { value: 'no',      label: "No, I don't have the funds right now" },
    ]
  },
  {
    field: 'effort',
    title: 'To build a successful and high-earning online store, it will require a lot of effort and dedication, are you willing to put in the work? (Even if you fail at first)',
    options: [
      { value: 'ready',    label: "I'm Ready to Learn and Work Hard" },
      { value: 'best',     label: "I'll Do My Best" },
    ]
  },
  {
    field: 'time',
    title: "You're required to have at least 1 to 2 hours daily to manage your business, do you have the time?",
    options: [
      { value: 'yes',      label: 'Yes, I have free time' },
      { value: 'makeTime', label: 'I can make time for it' },
      { value: 'no',       label: 'No, my schedule is full' },
    ]
  },
  {
    field: 'startTime',
    title: "If we're a good fit to help you build your online business, how soon can you start?",
    options: [
      { value: 'today',    label: 'Today' },
      { value: 'notReady', label: 'Not Ready Yet' },
    ]
  },
  {
    field: 'commitment',
    title: 'Is there any reason that will make you cancel the meeting? (unless you were swallowed by an earthquake 😅)',
    options: [
      { value: 'yes',   label: 'No, I will attend for sure' },
      { value: 'maybe', label: 'Maybe...' },
    ]
  }
];

const isQualified = (data) =>
  data.budget !== 'no' &&
  data.time   !== 'no' &&
  data.startTime !== 'notReady';

// ── Component ─────────────────────────────────────────────────────────────────
export default function Survey() {
  const [valid, setValid] = useState(null);
  const completedRef = useRef(false);

  useEffect(() => {
    setValid(!!getTokens().takeSurvey);

    const unlock = () => setValid(true);
    window.addEventListener('survey:unlock', unlock);

    const onUnload = () => {
      if (!completedRef.current) {
        window.dataLayer = window.dataLayer || [];
        window.dataLayer.push({ event: 'survey_abandoned' });
      }
    };
    window.addEventListener('beforeunload', onUnload);

    return () => {
      window.removeEventListener('survey:unlock', unlock);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, []);

  const [page, setPage]           = useState(0);
  const [answers, setAnswers]     = useState({ experience: '', budget: '', effort: '', time: '', startTime: '', commitment: '' });
  const [fieldError, setFieldError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  if (valid === null) return null;

  if (!valid) {
    return (
      <div style={{ minHeight: '60vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem', textAlign: 'center', gap: '1rem' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 700, color: '#111827' }}>
          Please subscribe first before taking the survey
        </h1>
        <a href="/survey" style={{ color: '#2563EB', textDecoration: 'underline' }}>← Go back</a>
      </div>
    );
  }

  const q     = questions[page];
  const total = questions.length;

  const handleNext = async () => {
    if (!answers[q.field]) {
      setFieldError('Please select an option to continue');
      return;
    }
    setFieldError('');

    if (page < total - 1) {
      setPage(page + 1);
      return;
    }

    // Survey complete
    completedRef.current = true;
    setSubmitting(true);
    setSubmitError('');
    const qualified = isQualified(answers);
    const userData  = getSavedUserData();

    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ event: 'survey_completed', survey_qualified: qualified, user_name: userData.name, user_email: userData.email, user_phone: userData.phone });

    createToken(qualified ? 'qualified' : 'unqualified');
    const list = qualified ? 'qualified_no_book' : 'unqualified';
    const redirect = () => { window.location.href = qualified ? '/choose-schedule' : '/get-free-program'; };
    if (userData.email) {
      fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: userData.name || '', email: userData.email, phone: userData.phone || '', list, referrer: sessionStorage.getItem('da_referrer') || '', ...getStoredUtms() }),
      }).finally(redirect);
    } else {
      redirect();
    }
  };

  return (
    <div className="survey-wrap">
      <style>{`
        .survey-page { transition: transform .4s cubic-bezier(.4,0,.2,1), opacity .4s ease; position: absolute; width: 100%; left: 0; top: 0; }
        .survey-page--active { position: relative; transform: translateX(0); opacity: 1; }
        .survey-page--left   { transform: translateX(-100%); opacity: 0; pointer-events: none; }
        .survey-page--right  { transform: translateX(100%);  opacity: 0; pointer-events: none; }
        @keyframes shine { 0%{left:-100%} 50%{left:100%} 100%{left:100%} }
        .progress-shine { position: relative; overflow: hidden; }
        .progress-shine::after { content:''; position:absolute; top:0; left:-100%; width:30%; height:100%; background:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.8),rgba(255,255,255,0)); animation:shine 2s ease-in-out infinite; transform:skewX(-20deg); }
      `}</style>

      <div className="survey-card">
        <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <img src="/Droparabia.png" alt="Droparabia" style={{ height: '40px', margin: '0 auto 0.75rem' }} />
          <h1 className="survey-title" style={{ fontSize: '1.2rem', lineHeight: 1.5 }}>
            Before we book you a call, we need to ask you a few questions to make sure we are the right fit for you
          </h1>
        </div>

        {/* Progress bar */}
        <div className="survey-progress-track">
          <div
            className="survey-progress-bar progress-shine"
            style={{ width: `${((page + 1) / total) * 100}%` }}
          />
        </div>
        <p className="survey-page-count">Question {page + 1} of {total}</p>

        {/* Questions */}
        <div className="survey-questions-wrap">
          {questions.map((question, i) => (
            <div
              key={i}
              className={`survey-page ${
                i === page ? 'survey-page--active' : i < page ? 'survey-page--left' : 'survey-page--right'
              }`}
            >
              <h2 className="survey-question">{question.title}</h2>
              <div className="survey-options">
                {question.options.map(opt => (
                  <label
                    key={opt.value}
                    className={`survey-option${answers[question.field] === opt.value ? ' survey-option--selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name={question.field}
                      value={opt.value}
                      checked={answers[question.field] === opt.value}
                      onChange={() => { setAnswers(p => ({ ...p, [question.field]: opt.value })); setFieldError(''); }}
                      className="survey-radio"
                    />
                    <span>{opt.label}</span>
                  </label>
                ))}
              </div>
              {fieldError && i === page && (
                <p className="survey-error survey-error--field">{fieldError}</p>
              )}
            </div>
          ))}
        </div>

        {submitError && <p className="survey-error survey-error--submit">{submitError}</p>}

        {/* Navigation */}
        <div className="survey-nav">
          {page > 0 && (
            <button
              onClick={() => { setPage(page - 1); setFieldError(''); }}
              className="survey-btn survey-btn--secondary"
            >
              ← Previous
            </button>
          )}
          <button onClick={handleNext} disabled={submitting} className="survey-btn">
            {submitting ? 'Processing...' : page === total - 1 ? 'Complete ✓' : 'Next →'}
          </button>
        </div>
      </div>
    </div>
  );
}
