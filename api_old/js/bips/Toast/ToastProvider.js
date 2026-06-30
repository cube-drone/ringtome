import { h } from 'preact';
import { useState, useCallback, useEffect } from 'preact/hooks';
import { ToastContext } from './ToastContext';
import htm from 'htm';

const html = htm.bind(h);

const ToastProvider = ({ children }) => {

  // toasts are a list of objects with { id, message, options }
  const [toasts, setToasts] = useState([]);

  const showToast = useCallback((message, options = {}) => {
    const id = Date.now() + Math.random();

    // add a new, oldest toast to the end of the list
    setToasts(t => [...t, { id, message, options }]);
  }, []);

  const dismissToast = (id) => {
    setToasts(t => t.filter(toast => toast.id !== id));
  }

  const getToasts = useCallback(() => toasts, [toasts]);

  const contextValue = {showToast, dismissToast, getToasts};

  useEffect(() => {
    // set a default toast so that I can test the Toast component
    //showToast("Welcome to the Toast Provider!", { variation: "success", duration: 3000 });
    //showToast("This is a second message!", { variation: "warning", duration: 5000 });
    //showToast("This is a third message!", { variation: "null", duration: 8000 });
  }, []);

  return html`
    <${ToastContext.Provider} value=${contextValue}>
      ${children}
    <//>
  `;
};

export default ToastProvider;