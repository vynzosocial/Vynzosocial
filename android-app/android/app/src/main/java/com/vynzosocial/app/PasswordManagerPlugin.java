package com.vynzosocial.app;

import android.os.CancellationSignal;
import androidx.core.content.ContextCompat;
import androidx.credentials.CreateCredentialResponse;
import androidx.credentials.CreatePasswordRequest;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.GetPasswordOption;
import androidx.credentials.PasswordCredential;
import androidx.credentials.exceptions.CreateCredentialException;
import androidx.credentials.exceptions.GetCredentialException;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "PasswordManager")
public class PasswordManagerPlugin extends Plugin {
    @PluginMethod
    public void save(PluginCall call) {
        String username = call.getString("username");
        String password = call.getString("password");
        if (username == null || username.isEmpty() || password == null || password.isEmpty()) {
            call.reject("Username and password are required.");
            return;
        }
        CredentialManager.create(getContext()).createCredentialAsync(
            getActivity(), new CreatePasswordRequest(username, password), new CancellationSignal(),
            ContextCompat.getMainExecutor(getActivity()), new CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException>() {
                @Override
                public void onResult(CreateCredentialResponse result) {
                    call.resolve();
                }

                @Override
                public void onError(CreateCredentialException error) {
                    call.reject("Password was not saved by the password manager.", error.getType());
                }
            }
        );
    }

    @PluginMethod
    public void select(PluginCall call) {
        GetCredentialRequest request = new GetCredentialRequest.Builder()
            .addCredentialOption(new GetPasswordOption())
            .build();
        CredentialManager.create(getContext()).getCredentialAsync(
            getActivity(), request, new CancellationSignal(), ContextCompat.getMainExecutor(getActivity()),
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(GetCredentialResponse result) {
                    if (!(result.getCredential() instanceof PasswordCredential)) {
                        call.reject("The selected credential is not a password.");
                        return;
                    }
                    PasswordCredential credential = (PasswordCredential) result.getCredential();
                    JSObject response = new JSObject();
                    response.put("username", credential.getId());
                    response.put("password", credential.getPassword());
                    call.resolve(response);
                }

                @Override
                public void onError(GetCredentialException error) {
                    call.reject("Could not select a saved password.", error.getType());
                }
            }
        );
    }
}
