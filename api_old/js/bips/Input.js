import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';

const html = htm.bind(h);


const validUuid = (value) => {
    // A valid UUID matches the pattern
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
};

const Input = ({
    type = "input",         // Can be 'text', 'email', 'password', 'tel', 'uuid', 'vercode', etc.
    required=false,         // If true, the input is required
    variant="default",      // Can be 'default', 'primary', 'warning', 'null', etc.
    successText="Nice!",    // Text to show when the input is valid
    regex,                  // Optional regex for validation
    hideHelpText=false,     // If true, hides the help text
    onChange,               // Callback for when the input changes
    onValid,                // Callback for when the input has changed, and is valid
    onInvalid,              // Callback for when the input has changed, and is invalid
    children,               // Label or placeholder text
    value='',
    ...props}) => {


    let [error, setError] = useState(null);
    let [success, setSuccess] = useState(null);

    useEffect(() => {
        if(success){
            console.log("Success:", success);
        }
    }, [success]);

    useEffect(() => {
        if(error){
            console.log("Error:", error);
        }
    }, [error]);

    let disabledStyle = '';
    if(props.disabled){
        disabledStyle = 'bip-input-disabled';
    }

    let id = props.id || children?.replace(/\s+/g, '-').toLowerCase();
    let label = props.label || children;

    if(required){
        label += ' *';
    }

    let currentDebouncedCallback = null;
    const onChangeDebounced = (e) => {
        // Debounce the onChange event to avoid too many calls
        if (currentDebouncedCallback) {
            clearTimeout(currentDebouncedCallback);
        }
        currentDebouncedCallback = setTimeout(() => {
            onChangeInner(e);
        }, 400);
        // why 400ms?
        // the average wpm is 40, which translates to about 333ms per character
        // so 400ms should be enough so that the average user can interrupt the next calculation
        //  so we only do the "calculation" after the user has stopped typing for a bit
        // but it still feels responsive!
    }

    const onChangeInner = (e) => {
        let inputValue = e.target.value;

        if(inputValue == null || inputValue == ''){
            inputValue = null;
        }

        console.log("Type: ", type, "Value:", inputValue);

        if(required && inputValue == null){
            setSuccess(false);
            setError('This field is required');
            e.valid = false;
        }
        else if(inputValue == null){
            console.dir("Input cleared");
            setSuccess(false);
            setError(null);
            e.valid = false;
        }
        else if(type === "text" && regex && !new RegExp(regex).test(inputValue)){
            setSuccess(false);
            setError(`Input does not match the required pattern: ${regex}`);
            e.valid = false;
        }
        else if(type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inputValue)){
            setSuccess(false);
            setError('A valid email address looks like this: valid-email-address@example.org');
            e.valid = false;
        }
        else if(type === "tel" && !/^[0-9 +-]+$/.test(inputValue)){
            setSuccess(false);
            setError('A valid phone number contains only numbers, spaces, and dashes');
            e.valid = false;
        }
        else if(type === "tel" && inputValue.replace(/\D/g, '').length < 10){
            setSuccess(false);
            setError('A valid phone number is at least 10 numbers long');
            e.valid = false;
        }
        else if(type === "email_or_tel" && !(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inputValue) || /^[0-9 +-]+$/.test(inputValue))){
            setSuccess(false);
            setError("That doesn't look like a valid email address or phone number");
            e.valid = false;
        }
        else if(type === "password" && inputValue.length < 8){
            setSuccess(false);
            setError('A valid password is at least 8 characters long');
            e.valid = false;
        }
        else if(type === "password" && inputValue === "password"){
            setSuccess(false);
            setError('That is just a dogshit password, try something else');
            e.valid = false;
        }
        else if(type === "password" && inputValue === "password1"){
            setSuccess(false);
            setError('Oh, sure, you think you are so clever, huh? Try something else');
            e.valid = false;
        }
        else if(type === "password" && inputValue === "password2"){
            setSuccess(false);
            setError('That is also a bad password, try something else.');
            e.valid = false;
        }
        else if(type === "password" && inputValue === "password11"){
            setSuccess(false);
            setError('That is not going to work either, try something else');
            e.valid = false;
        }
        else if(type === "password" && inputValue.includes("password") && inputValue.length < 12){
            setSuccess(false);
            setError('You can do better than that, try something else');
            e.valid = false;
        }
        else if(type === "password" && inputValue === "12345678"){
            setSuccess(false);
            setError("That's the kind of password an idiot would have on his luggage. Try something else.");
            e.valid = false;
        }
        else if(type === "uuid" && inputValue.length !== 36){
            setSuccess(false);
            setError('A valid UUID is 36 characters long');
            e.valid = false;
        }
        else if(type === "uuid" && !validUuid(inputValue)){
            setSuccess(false);
            setError('A valid UUID looks like this: 123e4567-e89b-12d3-a456-426614174000');
            e.valid = false;
        }
        else if(type === "vercode" && !/^\d{6}$/.test(inputValue)){
            setSuccess(false);
            setError('A valid verification code is a 6-digit number');
            e.valid = false;
        }
        else{
            console.log("Input valid");
            setSuccess(true);
            setError(null);
            e.valid = true;
        }

        if(e.valid){
            onValid?.(e);
        }
        else{
            onInvalid?.(e);
        }
        onChange?.(e);
    };

    let actualType = type;
    if(type === "uuid"){
        actualType = "input"; // UUIDs are just text, but we can validate them
    };
    if(type === "vercode"){
        actualType = "number"; // Verification codes are just numbers, but we can validate them
    }
    if(type === "email_or_tel"){
        actualType = "text";
    }

    let helpText = '';
    if(props.helpText != null){
        helpText = html`<br/><span class="bip-input-help-text">${props.helpText}</span>`;
    }

    let errorStyle = '';
    if(error){
        errorStyle = 'bip-input-error';
        helpText = html`<br/><span class="bip-input-error-text">${error}</span>`;
    }

    let successStyle = '';
    if(success){
        successStyle = 'bip-input-success';
        if(helpText && helpText != ''){
            helpText = html`<br/><span class="bip-input-success-text">${successText}</span>`;
        }
    }

    if(hideHelpText){
        helpText = '';
    }

    return html`
        <div class="bip-input-group">
            <label for=${id} class="bip-input-label bip-input-label-${variant} ${disabledStyle}">
                ${label}
            </label>
            <br/>
            <input
                type=${actualType}
                defaultValue=${value}
                class="bip-input bip-input-${variant} ${disabledStyle} ${errorStyle} ${successStyle}"
                onChange=${onChangeDebounced}
                ...${props} />
            ${helpText}
        </div>
    `;
};

export default Input;