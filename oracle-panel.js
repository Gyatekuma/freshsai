/* ══════════════════════════════════════════════
   THE ORACLE — Standalone accuracy tracker
   Injected into index.html via buildOraclePanel()
   ══════════════════════════════════════════════ */

var Oracle = (function() {
  var currentDate = '';
  var loading = false;

  // Called once on page load
  function init() {
    currentDate = todayStr();
    renderDateNav();
    load(currentDate);
  }

  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  function fmtShort(ds) {
    var d = new Date(ds + 'T12:00:00Z');
    return d.toLocaleDateString('en-GB', { day:'numeric', month:'short', timeZone:'UTC' });
  }

  function fmtDay(ds) {
    var d = new Date(ds + 'T12:00:00Z');
    var today = todayStr();
    if (ds === today) return 'Today';
    return d.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short', timeZone:'UTC' });
  }

  // ── Render date nav (last 7 days) ──────────────────────────
  function renderDateNav() {
    var nav = document.getElementById('oracleDateNav');
    if (!nav) return;
    var today = todayStr();
    var html = '';
    for (var i = 6; i >= 0; i--) {
      var d  = new Date(today + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() - i);
      var ds = d.toISOString().slice(0, 10);
      html += '<button class="o-date-btn' + (ds === currentDate ? ' active' : '') + '"'
        + ' data-date="' + ds + '" onclick="Oracle.select(\'' + ds + '\')">'
        + (i === 0 ? 'Today' : fmtShort(ds))
        + '</button>';
    }
    nav.innerHTML = html;
  }

  // ── Select a date ──────────────────────────────────────────
  function select(ds) {
    currentDate = ds;
    document.querySelectorAll('.o-date-btn').forEach(function(b) {
      b.classList.toggle('active', b.dataset.date === ds);
    });
    load(ds);
  }

  // ── Fetch Oracle data ──────────────────────────────────────
  function load(ds) {
    if (loading) return;
    loading = true;
    setPanel('<div class="o-loading"><div class="o-ld"></div>Loading results...</div>');

    fetch('/api/oracle?date=' + ds)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        loading = false;
        if (data.error) { setPanel('<p class="o-err">' + data.error + '</p>'); return; }
        render(data);
        // Also update FAB
        updateFab(data);
      })
      .catch(function(err) {
        loading = false;
        setPanel('<p class="o-err">Could not load data.</p>');
      });
  }

  // ── Render the full Oracle panel ──────────────────────────
  function render(data) {
    var html = '';

    // Date label
    html += '<div class="o-date-lbl">' + fmtDay(data.date) + '</div>';

    // No data
    if (!data.total) {
      html += '<div class="o-empty">📅 No fixtures found for this date.</div>';
      setPanel(html); return;
    }

    // Summary ring + stats
    var pct  = data.accuracy_pct;
    var CIRC = 238.76;
    var offset = pct !== null ? (CIRC - CIRC * pct / 100) : CIRC;
    var ringColor = pct === null ? '#E5E7EB' : pct >= 60 ? '#1D9E75' : pct >= 40 ? '#D97706' : '#DC2626';
    var pctClass  = pct === null ? '' : pct >= 60 ? 'g' : pct >= 40 ? 'a' : 'r';

    html += '<div class="o-ring-wrap">'
      + '<div class="o-ring">'
      + '<svg width="96" height="96" viewBox="0 0 96 96">'
      + '<circle cx="48" cy="48" r="38" fill="none" stroke="#F3F4F6" stroke-width="10"/>'
      + '<circle cx="48" cy="48" r="38" fill="none" stroke="' + ringColor + '" stroke-width="10"'
      + ' stroke-linecap="round" stroke-dasharray="' + CIRC + '" stroke-dashoffset="' + offset + '"'
      + ' style="transform:rotate(-90deg);transform-origin:48px 48px;transition:stroke-dashoffset 1s ease"/>'
      + '</svg>'
      + '<div class="o-ring-text">'
      + '<div class="o-pct ' + pctClass + '">' + (pct !== null ? pct + '%' : '—') + '</div>'
      + '<div class="o-pct-sub">accuracy</div>'
      + '</div></div>'
      + '<div class="o-mini-stats">'
      + oStat(data.correct,  'Correct', 'g')
      + oStat(data.wrong,    'Wrong',   'r')
      + oStat(data.pending + data.live, 'Pending', 'a')
      + '</div>'
      + (data.goals_pct !== null
          ? '<div class="o-goals-row">Goals: <strong>' + data.goals_pct + '%</strong> ('
            + data.goals_correct + '/' + data.goals_total + ' correct)</div>'
          : '')
      + '</div>';

    // Match breakdown
    if (data.matches && data.matches.length) {
      html += '<div class="o-matches">';
      data.matches.forEach(function(m) {
        var cls = !m.is_finished ? 'pending'
                : m.is_correct === true  ? 'correct'
                : m.is_correct === false ? 'wrong' : 'pending';
        var badge = !m.is_finished
          ? (m.is_live
              ? '<span class="o-badge live">● Live</span>'
              : '<span class="o-badge pending">' + fmtKO(m.kickoff_iso) + '</span>')
          : m.is_correct === true  ? '<span class="o-badge correct">✓</span>'
          : m.is_correct === false ? '<span class="o-badge wrong">✗</span>'
          : '<span class="o-badge pending">?</span>';

        var scoreStr = (m.score_home !== null && m.score_away !== null)
          ? '<span class="o-score">' + m.score_home + ' – ' + m.score_away + '</span>' : '';

        var goalsStr = '';
        if (m.goals_prediction && m.is_finished) {
          goalsStr = '<div class="o-goals-pred '
            + (m.goals_is_correct === true ? 'g' : m.goals_is_correct === false ? 'r' : '') + '">'
            + m.goals_prediction
            + (m.goals_is_correct === true ? ' ✓' : m.goals_is_correct === false ? ' ✗' : '') + '</div>';
        }

        html += '<div class="o-match ' + cls + '">'
          + '<div class="o-match-top">'
          + '<span class="o-match-teams">' + m.home + ' vs ' + m.away + '</span>'
          + badge + '</div>'
          + '<div class="o-match-pred">' + m.prediction + ' <span class="o-conf">(' + m.confidence + '%)</span>'
          + scoreStr + '</div>'
          + goalsStr
          + '</div>';
      });
      html += '</div>';
    }

    setPanel(html);
  }

  function oStat(val, label, cls) {
    return '<div class="o-mini-stat"><div class="o-mini-v ' + cls + '">' + val + '</div>'
      + '<div class="o-mini-l">' + label + '</div></div>';
  }

  function fmtKO(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', timeZone:'UTC' }) + ' GMT';
  }

  function setPanel(html) {
    var el = document.getElementById('oracleBody');
    if (el) el.innerHTML = html;
    // Also update mobile sheet
    var mob = document.getElementById('oracleSheetBody');
    if (mob) mob.innerHTML = html;
  }

  function updateFab(data) {
    var fab   = document.getElementById('oracleFab');
    var fabTxt = document.getElementById('oracleFabTxt');
    if (!fab) return;
    if (data.finished > 0) {
      fab.style.display = 'flex';
      if (fabTxt) fabTxt.textContent = (data.accuracy_pct !== null ? data.accuracy_pct + '%' : '—')
        + ' (' + data.correct + '/' + data.finished + ')';
    } else {
      fab.style.display = 'none';
    }
  }

  return { init:init, select:select, load:load };
})();
