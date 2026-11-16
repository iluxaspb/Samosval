import {createService} from './service.mjs';
import {installForms} from './forms.mjs';
import * as App from './app.mjs';
export async function mount(ctx,container){
  const api=installForms(await createService(ctx));api.container=container;
  let disposed=false,activeView='shift';const owner=api.context().actor.uid;
  api.leave=()=>ctx.ledgerHost.leave();
  async function activate(){if(disposed)return false;const session=ctx.ledgerHost.session();if(!session.tabAccess||session.status!=='active'||session.uid!==owner){await dispose();return false;}if(!container.querySelector('.tb-app'))await App.open(api,activeView);return true;}
  const observer=new MutationObserver(()=>{if(!container.isConnected||!container.classList.contains('active'))App.close(api);});observer.observe(container,{attributes:true,attributeFilter:['class']});
  async function dispose(){if(disposed)return;disposed=true;observer.disconnect();App.close(api);await api.dispose();}
  ctx.onDispose(dispose);await activate();return{activate,dispose};
}
