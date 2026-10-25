# Putting the bridge on the Raspberry Pi

You need: the Pi kit, a TV with a free HDMI input, a USB keyboard and
mouse (any), and the house Wi-Fi password. About 20 minutes.

## 1. Plug it in

1. Put the memory card in the slot on the underside of the Pi (it may
   already be in).
2. Snap the Pi into the case and plug in the fan if the kit says to.
3. Micro-HDMI cable from the Pi's **HDMI 0** port (the one nearer the
   USB-C power plug) to the TV. Keyboard and mouse into the USB ports.
4. Power last. The TV shows the Raspberry Pi desktop after a minute.

## 2. First-boot questions

The welcome wizard asks, in order:

- Country, language, time zone: **United States, American English, New York**.
- Username and password. Use username **tv** and a password you'll remember.
  (Any name works; `tv` keeps the address short.)
- Wi-Fi: pick the house network, type the password. If the Pi is next to
  the router, an Ethernet cable is better and skips this.
- Browser choice: either. Updates: let it run, it takes a few minutes.
- Restart when it asks.

## 3. One command

On the desktop, click the black **Terminal** icon in the top bar, then type
(or paste) this line and press Enter:

```
curl -fsSL https://raw.githubusercontent.com/joebkauf/optimum-remote/main/install-pi.sh | bash
```

It downloads the bridge, installs what it needs, sets it to start every
time the Pi powers on, and names the Pi **tv** on the network. Five
minutes. When it finishes it prints the address.

## 4. On the iPad / iPhone

1. Safari → `http://tv.local:4680`. If that name doesn't resolve on a
   phone, use the IP the installer printed, e.g. `http://192.168.1.23:4680`.
2. Share button → **Add to Home Screen**. It opens full screen like an app.
3. ⚙ Boxes & setup → **Find boxes and TVs on the Wi-Fi** → add each room.
   - Stream box: Pair box, type the code the TV shows.
   - Sony TV: Pre-Shared Key from the TV's IP Control menu.
   - Samsung TV: Allow on TV, then Allow on the set.
4. Edit → type the channel numbers. Star the favorites.

Unplug the keyboard, mouse and HDMI. The Pi lives by the router from now on.

## Later

- **Update** (after I push a fix): run the same command from step 3 again,
  or from any computer on the Wi-Fi: `ssh tv@tv.local` then the command.
- **Logs** if something is off: `sudo journalctl -u optimum-remote -f`
- **Fixed IPs**: in the router, reserve addresses for the Pi, every TV,
  every box and every blaster so nothing moves.
- **Florida**: same box, same steps. Its rooms are its own.

## If you'd rather skip the TV and keyboard

From a Mac or PC: install **Raspberry Pi Imager** (raspberrypi.com/software),
put the Pi's card in the kit's USB reader, choose Raspberry Pi 5 →
Raspberry Pi OS (64-bit) → the card. In the settings gear set hostname
`tv`, username `tv` and a password, the Wi-Fi name and password, and turn
on SSH. Write, put the card in the Pi, power it, wait two minutes, then
from the Mac or PC terminal: `ssh tv@tv.local` and run the step 3 command.
