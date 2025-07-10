import React, { useState, useEffect } from 'react';

const BACKEND_URL = 'https://echoesbackend.narju.net';

const MatchManager = () => {
  const [matches, setMatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [autoDownload, setAutoDownload] = useState(false);
  const [lastMatchCount, setLastMatchCount] = useState(0);

  // Load auto-download preference
  useEffect(() => {
    const saved = localStorage.getItem('autoDownload') === 'true';
    setAutoDownload(saved);
  }, []);

  // Save auto-download preference
  useEffect(() => {
    localStorage.setItem('autoDownload', autoDownload);
  }, [autoDownload]);

  // Fetch matches from backend
  const fetchMatches = async () => {
    try {
      const response = await fetch(`${BACKEND_URL}/api/matches`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      return data.matches || [];
    } catch (error) {
      console.error('Error fetching matches:', error);
      setError(`Error fetching matches: ${error.message}`);
      return [];
    }
  };

  // Refresh matches
  const refreshMatches = async () => {
    setLoading(true);
    setError(null);
    
    const newMatches = await fetchMatches();
    setMatches(newMatches);
    setLoading(false);
    
    // Check for new matches and auto-download if enabled
    if (autoDownload && newMatches.length > lastMatchCount && lastMatchCount > 0) {
      const newMatchCount = newMatches.length - lastMatchCount;
      alert(`New matches detected! Auto-downloading ${newMatchCount} match(es)...`);
      downloadAllMatches();
    }
    
    setLastMatchCount(newMatches.length);
  };

  // Download all matches
  const downloadAllMatches = async () => {
    try {
      const response = await fetch(`${BACKEND_URL}/api/matches/download`);
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `echoes-matches-summary-${Date.now()}.txt`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      alert(`Successfully downloaded summary of ${matches.length} matches!`);
    } catch (error) {
      console.error('Error downloading matches:', error);
      alert(`Error downloading matches: ${error.message}`);
    }
  };

  // Download single match
  const downloadMatch = async (matchId) => {
    try {
      const response = await fetch(`${BACKEND_URL}/api/matches/${matchId}`);
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      const blob = new Blob([JSON.stringify(data.match, null, 2)], { type: 'application/json' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${matchId}.json`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      alert(`Downloaded match: ${matchId}`);
    } catch (error) {
      console.error('Error downloading match:', error);
      alert(`Error downloading match: ${error.message}`);
    }
  };

  // View match details
  const viewMatch = (matchId) => {
    window.open(`${BACKEND_URL}/api/matches/${matchId}`, '_blank');
  };

  // Calculate statistics
  const stats = {
    totalMatches: matches.length,
    totalEvents: matches.reduce((sum, match) => sum + match.eventCount, 0),
    avgDuration: matches.length > 0 
      ? Math.round(matches.reduce((sum, match) => sum + match.duration, 0) / matches.length / 1000)
      : 0,
    lastMatch: matches.length > 0 
      ? new Date(matches[0].startTime).toLocaleDateString()
      : 'N/A'
  };

  // Auto-refresh every 30 seconds
  useEffect(() => {
    refreshMatches();
    const interval = setInterval(refreshMatches, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>🎮 Echoes Match Manager</h1>
      
      {error && (
        <div style={styles.error}>
          {error}
        </div>
      )}
      
      {/* Auto-download toggle */}
      <div style={styles.autoDownload}>
        <h3>🔄 Auto-Download</h3>
        <p>Automatically download matches when they're logged:</p>
        <label style={styles.toggleSwitch}>
          <input
            type="checkbox"
            checked={autoDownload}
            onChange={(e) => setAutoDownload(e.target.checked)}
            style={styles.toggleInput}
          />
          <span style={{
            ...styles.slider,
            backgroundColor: autoDownload ? '#2196F3' : '#ccc'
          }}>
            <span style={{
              ...styles.sliderThumb,
              transform: autoDownload ? 'translateX(26px)' : 'translateX(0)'
            }} />
          </span>
        </label>
        <span style={{
          marginLeft: '10px',
          color: autoDownload ? '#28a745' : '#dc3545'
        }}>
          {autoDownload ? 'Enabled' : 'Disabled'}
        </span>
      </div>
      
      {/* Statistics */}
      <div style={styles.stats}>
        <div style={styles.statCard}>
          <div style={styles.statNumber}>{stats.totalMatches}</div>
          <div style={styles.statLabel}>Total Matches</div>
        </div>
        <div style={styles.statCard}>
          <div style={styles.statNumber}>{stats.totalEvents}</div>
          <div style={styles.statLabel}>Total Events</div>
        </div>
        <div style={styles.statCard}>
          <div style={styles.statNumber}>{stats.avgDuration}</div>
          <div style={styles.statLabel}>Avg Duration (s)</div>
        </div>
        <div style={styles.statCard}>
          <div style={styles.statNumber}>{stats.lastMatch}</div>
          <div style={styles.statLabel}>Last Match</div>
        </div>
      </div>
      
      {/* Action buttons */}
      <div style={styles.actions}>
        <button style={styles.btn} onClick={refreshMatches}>
          🔄 Refresh Matches
        </button>
        <button style={{...styles.btn, ...styles.btnSuccess}} onClick={downloadAllMatches}>
          📦 Download All Matches
        </button>
        <button style={{...styles.btn, ...styles.btnSecondary}} onClick={() => window.open(BACKEND_URL, '_blank')}>
          🔗 Open Backend
        </button>
      </div>
      
      {/* Matches list */}
      <div style={styles.matchesList}>
        {loading ? (
          <div style={styles.loading}>Loading matches...</div>
        ) : matches.length === 0 ? (
          <div style={styles.loading}>No matches found</div>
        ) : (
          matches.map(match => (
            <div key={match.matchId} style={styles.matchItem}>
              <div style={styles.matchInfo}>
                <div style={styles.matchId}>{match.matchId}</div>
                <div style={styles.matchDetails}>
                  Players: {match.players.join(', ')} | 
                  Winner: {match.winner || 'N/A'} | 
                  Duration: {Math.round(match.duration / 1000)}s | 
                  Events: {match.eventCount} | 
                  {new Date(match.startTime).toLocaleString()}
                </div>
              </div>
              <div style={styles.matchActions}>
                <button 
                  style={{...styles.btn, ...styles.btnSmall}} 
                  onClick={() => downloadMatch(match.matchId)}
                >
                  📥
                </button>
                <button 
                  style={{...styles.btn, ...styles.btnSmall, ...styles.btnSecondary}} 
                  onClick={() => viewMatch(match.matchId)}
                >
                  👁️
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

const styles = {
  container: {
    maxWidth: '800px',
    margin: '0 auto',
    padding: '20px',
    fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif"
  },
  title: {
    color: '#333',
    textAlign: 'center',
    marginBottom: '30px'
  },
  error: {
    background: '#f8d7da',
    color: '#721c24',
    padding: '15px',
    borderRadius: '6px',
    marginBottom: '20px',
    border: '1px solid #f5c6cb'
  },
  autoDownload: {
    background: '#fff3cd',
    border: '1px solid #ffeaa7',
    padding: '15px',
    borderRadius: '6px',
    marginBottom: '20px'
  },
  toggleSwitch: {
    position: 'relative',
    display: 'inline-block',
    width: '60px',
    height: '34px'
  },
  toggleInput: {
    opacity: 0,
    width: 0,
    height: 0
  },
  slider: {
    position: 'absolute',
    cursor: 'pointer',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    transition: '.4s',
    borderRadius: '34px'
  },
  sliderThumb: {
    position: 'absolute',
    content: "",
    height: '26px',
    width: '26px',
    left: '4px',
    bottom: '4px',
    backgroundColor: 'white',
    transition: '.4s',
    borderRadius: '50%'
  },
  stats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: '20px',
    marginBottom: '30px'
  },
  statCard: {
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    color: 'white',
    padding: '20px',
    borderRadius: '8px',
    textAlign: 'center'
  },
  statNumber: {
    fontSize: '2em',
    fontWeight: 'bold',
    marginBottom: '5px'
  },
  statLabel: {
    fontSize: '0.9em',
    opacity: 0.9
  },
  actions: {
    display: 'flex',
    gap: '15px',
    marginBottom: '30px',
    flexWrap: 'wrap'
  },
  btn: {
    padding: '12px 24px',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '16px',
    fontWeight: 500,
    transition: 'all 0.3s ease',
    backgroundColor: '#007bff',
    color: 'white'
  },
  btnSuccess: {
    backgroundColor: '#28a745'
  },
  btnSecondary: {
    backgroundColor: '#6c757d'
  },
  btnSmall: {
    padding: '6px 12px',
    fontSize: '12px'
  },
  matchesList: {
    background: '#f8f9fa',
    borderRadius: '8px',
    padding: '20px',
    maxHeight: '400px',
    overflowY: 'auto'
  },
  matchItem: {
    background: 'white',
    padding: '15px',
    marginBottom: '10px',
    borderRadius: '6px',
    borderLeft: '4px solid #007bff',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  matchInfo: {
    flex: 1
  },
  matchId: {
    fontWeight: 'bold',
    color: '#333',
    marginBottom: '5px'
  },
  matchDetails: {
    fontSize: '0.9em',
    color: '#666'
  },
  matchActions: {
    display: 'flex',
    gap: '10px'
  },
  loading: {
    textAlign: 'center',
    padding: '20px',
    color: '#666'
  }
};

export default MatchManager; 