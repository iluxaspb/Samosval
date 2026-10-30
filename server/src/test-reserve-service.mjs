// Dedicated TEST Cloud Run process; independent of Synology and PostgreSQL.
import http from 'node:http';
import {initializeApp,getApps} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
import {getFirestore} from 'firebase-admin/firestore';
import {createReserveHttp} from './test-reserve-http.mjs';
if(process.env.FIREBASE_PROJECT_ID!=='samosval-offline'||
 (process.env.GOOGLE_CLOUD_PROJECT&&process.env.GOOGLE_CLOUD_PROJECT!=='samosval-offline'))
 throw Error('reserve-test-project-required');
if(getApps().length===0)initializeApp({projectId:'samosval-offline'});
const handler=createReserveHttp({
 firestore:getFirestore(),projectId:'samosval-offline',
 verifyToken:token=>getAuth().verifyIdToken(token),
 enabled:process.env.TEST_RESERVE_SERVE_ENABLED==='1'
});
http.createServer(handler).listen(Number(process.env.PORT||8080),'0.0.0.0',
 ()=>console.info('Samosval isolated TEST reserve ready'));
