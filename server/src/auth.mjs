import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

if (!process.env.FIREBASE_PROJECT_ID) throw new Error('FIREBASE_PROJECT_ID is required');
// JWT signatures are verified against Google's public keys; no service-account key in source control.
if (getApps().length===0) initializeApp({projectId:process.env.FIREBASE_PROJECT_ID});

import {identityClaims} from './identity-rules.mjs';

export async function verifyFirebaseIdentity(request) {
  const authHeader = String(request.headers.authorization||'');
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(authHeader);
  if (!match) return null;
  try {
    const user = await getAuth().verifyIdToken(match[1]);
    return identityClaims(user);
  } catch {
    return null;
  }
}

export async function verifyFirebaseUser(request) {
  return (await verifyFirebaseIdentity(request))?.uid||null;
}

