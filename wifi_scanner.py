import os
import time
from sys import argv
from threading import Thread

import pandas
from scapy.all import *

# initialize the networks dataframe that will contain all access points nearby
networks_df = pandas.DataFrame(columns=["BSSID", "SSID", "zone", "subzone", "dBm_Signal", "Channel", "Crypto"])
global n_measures
n_measures = 0

def callback(packet):
    global n_measures
    if packet.haslayer(Dot11Beacon):
        # extract the MAC address of the network
        bssid = packet[Dot11].addr2
        # get the name of it
        ssid = packet[Dot11Elt].info.decode()
        try:
            dbm_signal = packet.dBm_AntSignal
        except:
            dbm_signal = "N/A"
        # extract network stats
        try :
            stats = packet[Dot11Beacon].network_stats()
            
            # get the channel of the AP
            channel = stats.get("channel")

            # get the crypto
            crypto = stats.get("crypto")
        except :
            channel = "N/A"
            crypto =  "N/A"

        #Zone and subzone data
        zone = int(argv[1])
        subzone = int(argv[2])

        network_row = {
            'BSSID':bssid,
            'SSID':ssid,
            'zone':zone,
            'subzone':subzone,
            'dBm_Signal':dbm_signal,
            'Channel':channel,
            'Crypto':crypto
        }
        networks_df = pandas.DataFrame([network_row])
        if networks_df.shape[0] > 0 :
            n_measures += 1
            print(f'--- Measure {n_measures} ---')
            print(networks_df)
            time.sleep(0.25)
            
            #Append data to file
            f='data/scanned_networks.csv'
            if os.path.isfile(f) :
                networks_df.to_csv(f, mode='a', header=False)
            else :
                networks_df.to_csv(f, mode='a', header=True)
            
        
            

def change_channel():
    ch = 1
    while True:
        print(f'Channel {ch}')
        os.system(f"iwconfig {interface} channel {ch}")
        # switch channel from 1 to 14 each 0.5s
        if ch < 14 :
            ch = ch + 1
        if ch == 14 :
            ch = 36
        elif  ch >= 36 :
            ch = ch + 4
            if ch >= 64 :
                print('Finished')
                exit(-1)

        time.sleep(0.5)


if __name__ == "__main__":
    # interface name, check using iwconfig
    interface = "wlp1s0mon"
    # start the channel changer
    channel_changer = Thread(target=change_channel)
    channel_changer.daemon = True
    channel_changer.start()
    # start sniffing
    sniff(prn=callback, iface=interface)