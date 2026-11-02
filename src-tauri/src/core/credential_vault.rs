//! Windows Credential Manager adapter with local-user persistence.
//!
//! `keyring` writes Windows entries with enterprise persistence, which can be
//! rejected on personal Windows accounts. Keep the same target-name mapping
//! while writing credentials that persist for this Windows user on this PC.

#[cfg(windows)]
use std::ffi::c_void;

#[cfg(windows)]
use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND};
#[cfg(windows)]
use windows_sys::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_MAX_CREDENTIAL_BLOB_SIZE,
    CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
};

#[cfg(windows)]
fn target(service: &str, user: &str) -> Vec<u16> {
    format!("{user}.{service}")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(windows)]
fn last_error() -> String {
    std::io::Error::from_raw_os_error(unsafe { GetLastError() } as i32).to_string()
}

#[cfg(windows)]
pub fn store(service: &str, user: &str, value: &str) -> Result<(), String> {
    let target = target(service, user);
    let mut blob = Vec::with_capacity(value.len() * 2);
    for unit in value.encode_utf16() {
        blob.extend_from_slice(&unit.to_le_bytes());
    }
    if blob.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize {
        blob.fill(0);
        return Err("Credential exceeds the Windows Credential Manager size limit".into());
    }
    let credential = CREDENTIALW {
        Flags: 0,
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_ptr() as *mut u16,
        Comment: std::ptr::null_mut(),
        LastWritten: Default::default(),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: std::ptr::null_mut(),
        TargetAlias: std::ptr::null_mut(),
        UserName: std::ptr::null_mut(),
    };
    let result = unsafe { CredWriteW(&credential, 0) };
    blob.fill(0);
    if result == 0 {
        Err(last_error())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
pub fn load(service: &str, user: &str) -> Result<Option<String>, String> {
    let target = target(service, user);
    let mut credential = std::ptr::null_mut();
    if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } == 0 {
        let code = unsafe { GetLastError() };
        return if code == ERROR_NOT_FOUND {
            Ok(None)
        } else {
            Err(std::io::Error::from_raw_os_error(code as i32).to_string())
        };
    }
    let result = unsafe {
        let entry = &*credential;
        if entry.CredentialBlob.is_null() {
            Err("Windows Credential Manager returned an empty credential".to_string())
        } else if entry.CredentialBlobSize % 2 != 0 {
            Err("Windows Credential Manager returned an invalid credential".to_string())
        } else {
            let units = std::slice::from_raw_parts(
                entry.CredentialBlob as *const u16,
                entry.CredentialBlobSize as usize / 2,
            );
            let result = String::from_utf16(units).map_err(|error| error.to_string());
            std::ptr::write_bytes(entry.CredentialBlob, 0, entry.CredentialBlobSize as usize);
            result.map(Some)
        }
    };
    unsafe { CredFree(credential as *const c_void) };
    result
}

#[cfg(windows)]
pub fn delete(service: &str, user: &str) -> Result<(), String> {
    let target = target(service, user);
    if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } != 0 {
        return Ok(());
    }
    let code = unsafe { GetLastError() };
    if code == ERROR_NOT_FOUND {
        Ok(())
    } else {
        Err(std::io::Error::from_raw_os_error(code as i32).to_string())
    }
}
