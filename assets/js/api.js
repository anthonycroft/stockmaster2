// Client for the portfolio API. Portfolios are private: every call sends the
// owner's access key, which is asked for once and remembered on this device.

const ACCESS_KEY_STORE = 'stockmaster.accessKey';

class AuthError extends Error {}

function getAccessKey() {
  try { return localStorage.getItem(ACCESS_KEY_STORE) || ''; } catch (e) { return ''; }
}

function setAccessKey(key) {
  try {
    if (key) localStorage.setItem(ACCESS_KEY_STORE, key);
    else localStorage.removeItem(ACCESS_KEY_STORE);
  } catch (e) { /* storage unavailable - key lasts for this page only */ }
}

async function apiRequest(method, path, body) {
  const key = getAccessKey();
  if (!key) throw new AuthError('No access key');

  const opts = { method, headers: { 'Authorization': 'Bearer ' + key } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  let resp;
  try {
    resp = await fetch(path, opts);
  } catch (err) {
    throw new Error('Could not reach the server. Check your connection.');
  }
  const data = await resp.json().catch(() => ({}));
  if (resp.status === 401) {
    throw new AuthError(data.error || 'Access key missing or incorrect.');
  }
  if (!resp.ok) {
    throw new Error(data.error || `Server returned ${resp.status}`);
  }
  return data;
}

// Ask for the access key, check it against the server, and remember it.
// Resolves true if a valid key was entered, false if the user cancelled.
async function promptForAccessKey(message) {
  const result = await Swal.fire({
    title: 'Unlock your portfolios',
    text: message || 'Enter your Stockmaster access key.',
    input: 'password',
    inputPlaceholder: 'Access key',
    inputAttributes: { autocapitalize: 'off', autocorrect: 'off' },
    showCancelButton: true,
    confirmButtonText: 'Unlock',
    showLoaderOnConfirm: true,
    allowOutsideClick: () => !Swal.isLoading(),
    preConfirm: async (key) => {
      key = (key || '').trim();
      if (!key) {
        Swal.showValidationMessage('Enter the access key');
        return false;
      }
      const previous = getAccessKey();
      setAccessKey(key);
      try {
        await apiRequest('GET', '/api/session');
        return true;
      } catch (err) {
        setAccessKey(previous);
        Swal.showValidationMessage(err instanceof AuthError ? 'That key is not correct' : err.message);
        return false;
      }
    },
  });
  return result.isConfirmed === true;
}

const Api = {
  listPortfolios: () => apiRequest('GET', '/api/portfolios'),
  createPortfolio: (name) => apiRequest('POST', '/api/portfolios', { name }),
  renamePortfolio: (id, name) => apiRequest('PATCH', `/api/portfolios?id=${id}`, { name }),
  deletePortfolio: (id) => apiRequest('DELETE', `/api/portfolios?id=${id}`),
  listTransactions: (portfolioId) => apiRequest('GET', `/api/transactions?portfolio_id=${portfolioId}`),
  addTransaction: (portfolioId, tx) => apiRequest('POST', `/api/transactions?portfolio_id=${portfolioId}`, tx),
  updateTransaction: (id, tx) => apiRequest('PUT', `/api/transactions?id=${id}`, tx),
  deleteTransaction: (id) => apiRequest('DELETE', `/api/transactions?id=${id}`),
  importPortfolios: (portfolios, replace) => apiRequest('POST', '/api/import_portfolios', { portfolios, replace: !!replace }),
};
