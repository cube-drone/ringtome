import { h, Component, render, createRef } from 'preact';
import htm from 'htm';

import { Info, TriangleAlert, OctagonAlert, CircleOff, PartyPopper }  from 'lucide-preact';

const html = htm.bind(h);

const Alert = ({message, error, title, variant="error", show=true}) => {

    if(!message || message.length == 0){
        if(error && error.length > 0){
            message = error;
            variant = "error";
        }
        else{
            return null;
        }
    }
    if(!show){
        return null;
    }

    let icon = OctagonAlert;
    if(variant === "error"){
        title = title ?? "Error";
    }
    else if(variant === "warning"){
        icon = TriangleAlert;
        title = title ?? "Warning";
    }
    else if(variant === "info"){
        icon = Info;
        title = title ?? "Info";
    }
    else if(variant === "success"){
        icon = PartyPopper;
        title = title ?? "Success";
    }
    else if(variant === "null"){
        icon = CircleOff;
        title = title ?? "Null";
    }
    else{
        title = title ?? "Alert";
    }

    return html`
    <div class="bip-alert bip-alert-${variant}">
        <${icon} /><br/>
        <strong>${title}</strong><br/>
        ${message}
    </div>
    `;
}

export default Alert;