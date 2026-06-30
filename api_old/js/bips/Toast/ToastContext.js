import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

export const ToastContext = createContext(()=> {
    console.warn("ToastContext not provided");
    return;
});
export const useToast = () => useContext(ToastContext);