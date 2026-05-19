const registerForm = document.getElementById('registerForm');
const loginForm = document.getElementById('loginForm');
const userSettings = document.getElementById('userSettings');
const forgotPasswordForm = document.getElementById('forgotPasswordForm');
const resetPasswordForm = document.getElementById('resetPasswordForm');
const twoFactorForm = document.getElementById('twoFactorForm')
const security = document.getElementById('toggleTwoFactorBtn');

// Register form
if (registerForm) {
    registerForm.addEventListener('submit', (e) => {
        e.preventDefault();

        const userName = document.getElementById('userName').value;
        const userEmail = document.getElementById('userEmail').value;
        const userPassword = document.getElementById('userPassword').value;
        const userConfirmPassword = document.getElementById('userConfirmPassword').value;

        const passwordError = document.getElementById("password-error");
        const userNameError = document.getElementById("userName-error");
        const emailError = document.getElementById("userEmailError");

        passwordError.style.display = "none";
        passwordError.textContent = "";
        userNameError.style.display = "none";
        userNameError.textContent = "";
        emailError.style.display = "none";
        emailError.textContent = "";

        if (userPassword.length < 8) {
            passwordError.textContent = "Password must be at least 8 characters.";
            passwordError.style.display = "block";
            return;
        }

        if (userPassword !== userConfirmPassword) {
            passwordError.textContent = "Passwords don't match.";
            passwordError.style.display = "block";
            return;
        }

        fetch('/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userName, userEmail, userPassword, userConfirmPassword }),
        })
            .then(res => res.json())
            .then(data => {
                console.log(data);
                if (data.error) {
                    if (data.error.toLowerCase().includes("username")) {
                        userNameError.textContent = data.error;
                        userNameError.style.display = "block";
                    } else if (data.error.toLowerCase().includes("password")) {
                        passwordError.textContent = data.error;
                        passwordError.style.display = "block";
                    } else if (data.error.toLowerCase().includes("email")) {
                        emailError.textContent = data.error;
                        emailError.style.display = "block";
                    }
                } else {
                    console.log('Registered successfully!');
                    alert('Please check your email for a verification email, make sure to check your spam!');
                    window.location.href = "index.html";
                }
            })
            .catch(err => console.error(err));
    });
}

// Login form
if (loginForm) {
    loginForm.addEventListener('submit', (e) => {
        e.preventDefault();

        const userLoginEmail = document.getElementById('userLoginEmail').value;
        const userLoginPassword = document.getElementById('userLoginPassword').value;

        const userLoginEmailError = document.getElementById("userLoginEmailError");
        const passwordLoginError = document.getElementById("password-LoginError");

        userLoginEmailError.style.display = "none";
        userLoginEmailError.textContent = "";
        passwordLoginError.style.display = "none";
        passwordLoginError.textContent = "";

        fetch('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userLoginEmail, userLoginPassword }),
        })
            .then(res => res.json())
            .then(data => {
                console.log(data);
                if (data.error) {
                    if (data.error.toLowerCase().includes("email") || data.error.toLowerCase().includes("credentials")) {
                        userLoginEmailError.textContent = data.error;
                        userLoginEmailError.style.display = "block";
                    } else if (data.error.toLowerCase().includes("password") || data.error.toLowerCase().includes("credentials")) {
                        passwordLoginError.textContent = data.error;
                        passwordLoginError.style.display = "block";
                    } else if (data.error.toLowerCase().includes("verification")) {
                        alert(data.error);
                    }
                } else if (data.requiresTwoFactor) {
                    console.log('2fa required.')
                    window.location.href = 'two-factor.html'
                }
                else {
                    console.log('Logged in successfully!');
                    window.location.href = "dashboard.html";
                }
            })
            .catch(err => console.error(err));
    });
}

// Dashboard / user settings
if (userSettings) {
    let currentUser = null;

    fetch('/session')
        .then(res => res.json())
        .then(data => {
            if (!data.user) {
                window.location.href = 'login.html';
            } else {
                currentUser = data.user;
                //document.getElementById('welcomeMessage').textContent = `Welcome, ${data.user.userName}!`;
                document.getElementById('userNameInput').value = data.user.userName;
                document.getElementById('userEmailInput').value = data.user.userEmail;
                document.getElementById('userPasswordInput').value = '';
            }
        });

    document.getElementById('logoutBtn').addEventListener('click', () => {
        fetch('/logout', { method: 'POST' })
            .then(() => window.location.href = 'index.html');
    });

    document.getElementById('changeNameBtn').addEventListener('click', () => {
        const input = document.getElementById('userNameInput');
        const btn = document.getElementById('changeNameBtn');

        if (input.hasAttribute('readonly')) {
            input.removeAttribute('readonly');
            input.focus();
            btn.textContent = 'Save';
        } else {
            fetch('/updateName', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ newName: input.value })
            })
                .then(res => res.json())
                .then(data => {
                    if (data.error) {
                        alert(data.error);
                    } else {
                        input.setAttribute('readonly', true);
                        btn.textContent = 'Change';
                    }
                })
                .catch(err => console.error(err));
        }
    });

    document.getElementById('changePasswordBtn').addEventListener('click', () => {
        fetch('/forgotPassword', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestEmail: currentUser.userEmail })
        })
            .then(res => res.json())
            .then(() => {
                alert('Please check your emails.');
            })
            .catch(err => {
                console.error(err);
                alert('There has been an error in processing your request.');
            });
    });
}

// Forgot password form
if (forgotPasswordForm) {
    forgotPasswordForm.addEventListener('submit', (e) => {
        e.preventDefault();

        const requestEmail = document.getElementById('requestEmail').value;
        const userEmailError = document.getElementById('userEmailError');

        userEmailError.style.display = "none";
        userEmailError.textContent = "";

        fetch('/forgotPassword', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestEmail })
        })
            .then(res => res.json())
            .then(data => {
                alert('If your account exists, we will send you a link to reset your password.');
                window.location.href = 'login.html';
            })
            .catch(err => console.error(err));
    });
}

// Reset password form
if (resetPasswordForm) {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');

    resetPasswordForm.addEventListener('submit', (e) => {
        e.preventDefault();

        const newPassword = document.getElementById('newPassword').value;
        const confirmPassword = document.getElementById('confirmPassword').value;
        const newPasswordError = document.getElementById('newPasswordError');
        const confirmPasswordError = document.getElementById('confirmPasswordError');

        newPasswordError.style.display = "none";
        newPasswordError.textContent = "";
        confirmPasswordError.style.display = "none";
        confirmPasswordError.textContent = "";

        if (!token) {
            newPasswordError.textContent = "Invalid or expired reset link.";
            newPasswordError.style.display = "block";
            return;
        }

        if (newPassword.length < 8) {
            newPasswordError.textContent = "Password must be at least 8 characters.";
            newPasswordError.style.display = "block";
            return;
        }

        if (confirmPassword !== newPassword) {
            confirmPasswordError.textContent = "Passwords don't match.";
            confirmPasswordError.style.display = "block";
            return;
        }

        fetch('/updatePassword', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, newPassword }),
        })
            .then(res => res.json())
            .then(data => {
                console.log(data);
                if (data.error) {
                    newPasswordError.textContent = data.error;
                    newPasswordError.style.display = 'block';
                } else {
                    alert('Password updated successfully!');
                    window.location.href = 'login.html';
                }
            })
            .catch(err => console.error(err));
    });
}


if (twoFactorForm) {
    twoFactorForm.addEventListener('submit', (e) => {
        e.preventDefault();

        const code = document.getElementById('twoFactorCode').value;
        const twoFactorError = document.getElementById('twoFactorError')

        twoFactorError.style.display = 'none';
        twoFactorError.textContent = '';

        fetch('/verifyTwoFactor', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        })

            .then(res => res.json())
            .then(data => {
                if (data.error) {
                    twoFactorError.textContent = data.error;
                    twoFactorError.style.display = 'block';
                } else {
                    window.location.href = 'dashboard.html'
                }
            })
            .catch(err => console.error(err));
    });
}

if (security) {
    let currentUser = null;

   fetch('/session')
    .then(res => res.json())
    .then(data => {
        if (!data.user) {
            window.location.href = 'login.html';
        } else {
            currentUser = data.user;
            // Now fetch 2FA status after session is confirmed
            return fetch('/twoFactorStatus');
        }
    })
    .then(res => res.json())
    .then(data => {
        updateTwoFactorUI(data.enrolled);
    });

    function updateTwoFactorUI(enrolled) {
        const status = document.getElementById('twoFactorStatus');
        const btn = document.getElementById('toggleTwoFactorBtn');

        if (enrolled) {
            status.textContent = 'Enabled'
            status.style.color = '#17726D'
            btn.textContent = 'Disable';
            btn.style.background = '#C0392B'
        } else {
            status.textContent = 'Disabled';
            status.style.color = '#c0392b';
            btn.textContent = 'Enable';
            btn.style.background = '#17726d';
        }
    }

    document.getElementById('toggleTwoFactorBtn').addEventListener('click', () => {
        fetch('/toggleTwoFactor', { method: 'POST' })
            .then(res => res.json())
            .then(data => {
                if (data.error) {
                    alert(data.error);
                } else {
                    updateTwoFactorUI(data.enrolled);
                }
            })
            .catch(err => console.error(err));
    });

    document.getElementById('requestDataBtn').addEventListener('click', () => {
        fetch('/requestData')
            .then(res => res.json())
            .then(() => {
                document.getElementById('requestDataMsg').style.display = 'block';
            })

            .catch(err => console.error(err))
    });

    document.getElementById('deleteAccountBtn').addEventListener('click', () => {
        const confirmed = window.confirm('Are you sure? This cannot be undone')
        if (confirmed) {
            fetch('/deleteAccount', { method: 'DELETE' })
                .then(res => res.json())
                .then(() => {
                    alert('Your account has been deleted,')
                    window.location.href = 'index.html'
                })
                .catch(err => console.error(err))
        }
    });

    document.getElementById('logoutBtn').addEventListener('click', () => {
        fetch('/logout', { method: 'POST' })
            .then(() => window.location.href = 'index.html');
    });

    document.getElementById('resendCodeBtn') &&
        document.getElementById('resendCodeBtn').addEventListener('click', () => {
            fetch('/resendTwoFactor', { method: 'POST' })
                .then(res => res.json())
                .then(data => {
                    if (data.error) {
                        alert(data.error);
                    } else {
                        alert('Code resent! Check your email.');
                    }
                })
                .catch(err => console.error(err));
        });
}

