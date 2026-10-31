// One pinned browser, one explicitly selected chat. This is not a per-user ACL.
export function createHandoff() {
  let state = { chat: null, phase: 'inactive', revision: 0 };
  return {
    get: () => ({ ...state }),
    change(action, chat) {
      if (!/^\/server\/[^/]+\/session\/ses[a-zA-Z0-9_-]+$/.test(chat || '')) throw Error('Invalid chat path');
      if (!['show', 'login', 'resume', 'finish'].includes(action)) throw Error('Invalid action');
      if (state.chat && state.chat !== chat && state.phase !== 'inactive') throw Error('Browser belongs to another chat');
      if (action === 'show' && state.phase === 'login') throw Error('User has not returned control');
      if (action === 'resume' && (state.chat !== chat || state.phase !== 'login')) throw Error('No login request');
      state = { chat, phase: { show: 'working', login: 'login', resume: 'working', finish: 'inactive' }[action], revision: state.revision + 1 };
      return { ...state };
    },
  };
}
