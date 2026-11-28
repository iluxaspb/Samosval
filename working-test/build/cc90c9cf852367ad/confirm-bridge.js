
window.appConfirm=function(message){return window.showConfirmModal('Подтверждение',escapeHtml(String(message)).replace(/\n/g,'<br>'),{confirmLabel:'Подтвердить',cancelLabel:'Назад'});};
window.appNotice=function(message){return window.showConfirmModal('Сообщение',escapeHtml(String(message)).replace(/\n/g,'<br>'),{confirmLabel:'Понятно',hideCancel:true});};
